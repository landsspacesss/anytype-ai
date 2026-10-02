import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import sharp from "sharp";
import type { AnytypeClient } from "../anytype/client.js";

/** Cap how many page images we attach per read, and the max edge length. */
const MAX_IMAGES_PER_READ = 6;
const MAX_IMAGE_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 80;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Minimal object reference shape returned by the list/search endpoints. */
interface ObjectRef {
  id: string;
  name: string;
  type: string;
}

/** Object types that are NOT user content (chats, system containers, templates). */
const NON_CONTENT_TYPES = new Set([
  "chat",
  "chat_derived",
  "template",
  "widget",
  "space",
  "participant",
]);

/** True for real user content (pages, notes, tasks, …), false for chats/system objects. */
function isContentObject(o: ObjectRef): boolean {
  return !NON_CONTENT_TYPES.has((o.type || "").toLowerCase());
}

/** Build an AgentToolResult carrying a single text blob. */
function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/** Render a list of objects as a readable numbered list: `name (type) — id`. */
function renderList(items: ObjectRef[]): string {
  if (items.length === 0) return "The Anytype space contains no matching objects.";
  return items
    .map((o, i) => `${i + 1}. ${o.name || "(untitled)"} (${o.type || "unknown"}) — ${o.id}`)
    .join("\n");
}

/** Render a single Anytype block as a Markdown line (without the indent prefix). */
function blockToMarkdown(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "";
  const text = typeof block.text === "string" ? block.text : "";
  const checked = block.checked === true;

  switch (type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "heading_4": return `#### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "toggle": return `- ${text} ▸`;
    case "checkbox": return `- [${checked ? "x" : " "}] ${text}`;
    case "quote": return `> ${text}`;
    case "callout": return `> ${text}`;
    case "code": {
      const lang = typeof block.language === "string" ? block.language : "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "divider": return "---";
    case "image": {
      const label = typeof block.name === "string" && block.name.length > 0 ? block.name : "image";
      const oid = typeof block.object_id === "string" ? block.object_id : "";
      return `![${label}](${oid})`;
    }
    case "file": {
      const label = typeof block.name === "string" && block.name.length > 0 ? block.name : "file";
      const oid = typeof block.object_id === "string" ? block.object_id : "";
      return `[${label}](${oid})`;
    }
    case "paragraph": return text;
    default: return text;
  }
}

/**
 * Render an AnyBlock document as Markdown for the model: the object title plus
 * every block converted to Markdown (headings, lists, checkboxes, code fences,
 * quotes, images), preserving nesting via `indent`. Robust to missing fields.
 */
function renderObject(doc: unknown): string {
  if (doc === null || typeof doc !== "object") return "Object has no readable content.";
  const d = doc as Record<string, unknown>;
  const props = (d.properties ?? {}) as Record<string, unknown>;
  // `name` comes back as a string normally, but as a 1-element array after a
  // set_properties patch. Accept both.
  const rawName = props.name;
  const nameStr = Array.isArray(rawName) ? rawName[0] : rawName;
  const title = typeof nameStr === "string" && nameStr.length > 0 ? nameStr : "(untitled)";

  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  const lines: string[] = [`# ${title}`, ""];
  let rendered = 0;
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    const md = blockToMarkdown(block);
    if (md.trim().length === 0) continue;
    const indent = typeof block.indent === "number" && block.indent > 0 ? block.indent : 0;
    lines.push("  ".repeat(indent) + md);
    rendered++;
  }
  if (rendered === 0) {
    // No renderable content — describe what IS there by block type.
    const counts = new Map<string, number>();
    for (const b of blocks) {
      if (b === null || typeof b !== "object") continue;
      const t = typeof (b as Record<string, unknown>).type === "string"
        ? ((b as Record<string, unknown>).type as string)
        : "unknown";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const summary = counts.size > 0
      ? [...counts].map(([t, n]) => `${n}× ${t}`).join(", ")
      : "none";
    lines.push(`(no readable content; ${blocks.length} block(s): ${summary})`);
  }
  return lines.join("\n");
}

/** Convert an unknown thrown value into a short message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Image blocks in a document: their file object id + mime type. */
function extractImages(doc: unknown): Array<{ objectId: string; mimeType: string }> {
  if (doc === null || typeof doc !== "object") return [];
  const blocks = (doc as Record<string, unknown>).blocks;
  if (!Array.isArray(blocks)) return [];
  const out: Array<{ objectId: string; mimeType: string }> = [];
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "image") continue;
    const objectId = block.object_id;
    const mimeType = block.mime_type;
    if (typeof objectId === "string" && objectId.length > 0) {
      out.push({ objectId, mimeType: typeof mimeType === "string" ? mimeType : "image/*" });
    }
  }
  return out;
}

/**
 * Downscale an image so it can be sent to the model: cap the long edge and
 * re-encode as JPEG. Returns base64 + mime type, or null if it isn't a usable
 * raster image. (Astra/DeepSeek accept jpeg/png/webp; we normalise to jpeg.)
 */
async function resizeForModel(buf: Buffer, mimeType: string): Promise<{ data: string; mimeType: string } | null> {
  if (!mimeType.startsWith("image/")) return null;
  try {
    const out = await sharp(buf)
      .rotate() // honour EXIF orientation
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMAGE_JPEG_QUALITY })
      .toBuffer();
    return { data: out.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

const GUIDELINES = [
  "You are an AI assistant living INSIDE an Anytype space. The user's notes, pages, and objects live in Anytype — not on the local filesystem.",
  "For ANYTHING about the user's notes, pages, objects, or other content (including questions like \"how many notes are there?\" or \"find my note about X\"), ALWAYS use the `anytype_*` tools instead of listing/reading local workspace files.",
  "Never assume the words \"notes\" or \"笔记\" refer to local files — in this environment they mean Anytype objects in the current space.",
  "For pages that are scans/photos (试卷, receipts, screenshots): read the downscaled overview first, then use `anytype_download_images` + `crop_image` to zoom into a region. Cropping a small region at full resolution is how you read small or handwritten detail.",
];

/**
 * Build the Anytype tool set bound to one space via the shared client.
 * Results are returned as text content; failures are surfaced to the model as
 * text (never thrown out of `execute`) so it can adapt.
 */
export function createAnytypeTools(deps: {
  api: AnytypeClient;
  spaceId: string;
  /** Directory the agent may write downloaded images into. */
  workspaceDir: string;
}): ToolDefinition[] {
  const { api, spaceId, workspaceDir } = deps;

  /** Where a page's downloaded images live. */
  const imagesDirFor = (objectId: string): string =>
    path.join(workspaceDir, "images", objectId.slice(0, 24));

  const listObjects = defineTool({
    name: "anytype_list_objects",
    label: "List Anytype objects",
    description:
      "List the objects (notes, pages, etc.) in the current Anytype space. Use this to answer questions about how many objects exist or to browse the space.",
    promptSnippet: "anytype_list_objects — list the objects/notes in the current Anytype space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Optional maximum number of objects to return." })),
    }),
    async execute(_toolCallId, params) {
      try {
        let items = (await api.listObjects(spaceId)).filter(isContentObject);
        if (typeof params.limit === "number" && params.limit >= 0) items = items.slice(0, params.limit);
        return textResult(`${items.length} object(s) in the space:\n${renderList(items)}`);
      } catch (err) {
        return textResult(`anytype_list_objects failed: ${errMessage(err)}`);
      }
    },
  });

  const search = defineTool({
    name: "anytype_search",
    label: "Search Anytype",
    description:
      "Search the current Anytype space for objects matching a text query. Use this to find notes/pages by title or content.",
    promptSnippet: "anytype_search — search the Anytype space for objects matching a query",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      query: Type.String({ description: "The search text." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const items = (await api.search(spaceId, params.query)).filter(isContentObject);
        return textResult(`Search results for "${params.query}":\n${renderList(items)}`);
      } catch (err) {
        return textResult(`anytype_search failed: ${errMessage(err)}`);
      }
    },
  });

  const readObject = defineTool({
    name: "anytype_read_object",
    label: "Read Anytype object",
    description:
      "Read a single Anytype object by id. Returns its title, its text content, and any images on the page (images are attached so you can see them). Use the id from anytype_list_objects or anytype_search.",
    promptSnippet: "anytype_read_object — read an Anytype object's title, text, and images by id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to read." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const doc = await api.getObjectRaw(spaceId, params.id);
        const content: Content[] = [{ type: "text", text: renderObject(doc) }];

        // Attach the page's images so the (multimodal) model can actually see
        // them. Download, downscale, and send as image content.
        const images = extractImages(doc);
        const chosen = images.slice(0, MAX_IMAGES_PER_READ);
        for (const img of chosen) {
          try {
            const { data, mimeType } = await api.downloadFileContent(spaceId, img.objectId);
            const resized = await resizeForModel(data, mimeType);
            if (resized) content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
          } catch {
            // Skip an image that fails rather than failing the whole read.
          }
        }
        if (images.length > chosen.length) {
          content.push({
            type: "text",
            text: `(attached the first ${chosen.length} of ${images.length} images)`,
          });
        }
        return { content, details: {} };
      } catch (err) {
        return textResult(`anytype_read_object failed: ${errMessage(err)}`);
      }
    },
  });

  const createNote = defineTool({
    name: "anytype_create_note",
    label: "Create Anytype note",
    description:
      "Create a new page/note in the current Anytype space with a title and optional markdown body. Returns the new object id.",
    promptSnippet: "anytype_create_note — create a new page/note in the Anytype space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "The title of the new note." }),
      markdown: Type.Optional(Type.String({ description: "Optional markdown body." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const created = await api.createObject(spaceId, { name: params.name, markdown: params.markdown });
        return textResult(`Created note "${params.name}" with id ${created.id}`);
      } catch (err) {
        return textResult(`anytype_create_note failed: ${errMessage(err)}`);
      }
    },
  });

  const downloadImages = defineTool({
    name: "anytype_download_images",
    label: "Download a page's images",
    description:
      "Download every image on an Anytype object to the local workspace and return their file paths and pixel dimensions. Use this to get full-resolution images you can then zoom into with `crop_image` (and `read` them like any other local file).",
    promptSnippet: "anytype_download_images — save a page's images locally (paths + dimensions)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The Anytype object id whose images to download." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const doc = await api.getObjectRaw(spaceId, params.id);
        const images = extractImages(doc);
        if (images.length === 0) return textResult("That object has no images.");
        const dir = imagesDirFor(params.id);
        fs.mkdirSync(dir, { recursive: true });
        const out: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          try {
            const { data, mimeType } = await api.downloadFileContent(spaceId, img.objectId);
            const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
            const file = path.join(dir, `${i}.${ext}`);
            fs.writeFileSync(file, data);
            const meta = await sharp(data).metadata();
            out.push(`${i}. ${file} (${meta.width}×${meta.height})`);
          } catch (err) {
            out.push(`${i}. (download failed: ${errMessage(err)})`);
          }
        }
        return textResult(`Downloaded ${images.length} image(s):\n${out.join("\n")}`);
      } catch (err) {
        return textResult(`anytype_download_images failed: ${errMessage(err)}`);
      }
    },
  });

  const cropImage = defineTool({
    name: "crop_image",
    label: "View / crop a local image",
    description:
      "View a locally downloaded image, optionally cropping a region to see detail at higher resolution. Coordinates are fractions of the image (0..1): x,y = top-left corner, width,height = size. Omit all four to view the whole image. Cropping a small region is the best way to read small or handwritten text.",
    promptSnippet: "crop_image — view (or zoom into a region of) a downloaded image by path",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: "Path to an image (e.g. from anytype_download_images)." }),
      x: Type.Optional(Type.Number({ description: "Left edge as a fraction 0..1 (default 0)." })),
      y: Type.Optional(Type.Number({ description: "Top edge as a fraction 0..1 (default 0)." })),
      width: Type.Optional(Type.Number({ description: "Width as a fraction 0..1 (default 1)." })),
      height: Type.Optional(Type.Number({ description: "Height as a fraction 0..1 (default 1)." })),
    }),
    async execute(_toolCallId, params) {
      try {
        // Only allow reading files inside the agent workspace.
        const resolved = path.resolve(params.path);
        const root = path.resolve(workspaceDir);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          return textResult(`crop_image refused: path must be inside ${root}`);
        }
        if (!fs.existsSync(resolved)) return textResult(`crop_image: no such file: ${resolved}`);
        const buf = fs.readFileSync(resolved);
        const meta = await sharp(buf).metadata();
        const W = meta.width ?? 0;
        const H = meta.height ?? 0;
        if (!W || !H) return textResult("crop_image: not a readable image.");

        const hasCrop =
          params.x !== undefined || params.y !== undefined ||
          params.width !== undefined || params.height !== undefined;
        let pipeline = sharp(buf).rotate();
        if (hasCrop) {
          const clamp = (v: number | undefined, dflt: number): number =>
            Math.max(0, Math.min(1, v ?? dflt));
          const fx = clamp(params.x, 0);
          const fy = clamp(params.y, 0);
          const fw = clamp(params.width, 1);
          const fh = clamp(params.height, 1);
          const left = Math.round(fx * W);
          const top = Math.round(fy * H);
          const width = Math.max(1, Math.min(W - left, Math.round(fw * W)));
          const height = Math.max(1, Math.min(H - top, Math.round(fh * H)));
          pipeline = pipeline.extract({ left, top, width, height });
        }
        // Fit the (cropped) region into 1600px; don't enlarge a small crop.
        const out = await pipeline
          .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toBuffer();
        const label = hasCrop ? "cropped region" : "full image";
        return {
          content: [
            { type: "text", text: `${label} of ${path.basename(resolved)} (${W}×${H} source)` },
            { type: "image", data: out.toString("base64"), mimeType: "image/jpeg" },
          ],
          details: {},
        };
      } catch (err) {
        return textResult(`crop_image failed: ${errMessage(err)}`);
      }
    },
  });

  const updateObject = defineTool({
    name: "anytype_update_object",
    label: "Update Anytype object",
    description:
      "Edit an existing Anytype object: rename it and/or append markdown to the end of its body. Provide at least one of `name` (new title) or `append_markdown` (markdown appended as new content).",
    promptSnippet: "anytype_update_object — rename an object and/or append markdown to it",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to update." }),
      name: Type.Optional(Type.String({ description: "New title for the object." })),
      append_markdown: Type.Optional(
        Type.String({ description: "Markdown to append to the end of the object's body." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const ops: unknown[] = [];
        if (params.name !== undefined) {
          ops.push({ op: "set_properties", set: { name: [params.name] } });
        }
        if (params.append_markdown !== undefined) {
          ops.push({ op: "insert_blocks", markdown: params.append_markdown, position: "last" });
        }
        if (ops.length === 0) {
          return textResult("anytype_update_object: provide `name` and/or `append_markdown`.");
        }
        await api.patchObject(spaceId, params.id, ops);
        const parts: string[] = [];
        if (params.name !== undefined) parts.push(`renamed to "${params.name}"`);
        if (params.append_markdown !== undefined) parts.push("appended markdown");
        return textResult(`Updated object ${params.id}: ${parts.join(", ")}.`);
      } catch (err) {
        return textResult(`anytype_update_object failed: ${errMessage(err)}`);
      }
    },
  });

  const deleteObject = defineTool({
    name: "anytype_delete_object",
    label: "Delete Anytype object",
    description:
      "Delete an Anytype object (a note/page, collection, or file) by id. This is permanent — confirm the id first with anytype_list_objects or anytype_search.",
    promptSnippet: "anytype_delete_object — permanently delete an Anytype object by id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to delete." }),
    }),
    async execute(_toolCallId, params) {
      try {
        await api.deleteObject(spaceId, params.id);
        return textResult(`Deleted object ${params.id}.`);
      } catch (err) {
        return textResult(`anytype_delete_object failed: ${errMessage(err)}`);
      }
    },
  });

  const setProperty = defineTool({
    name: "anytype_set_property",
    label: "Set Anytype object property",
    description:
      "Set/add/remove a property value on an Anytype object. `set`/`add`/`remove` are objects mapping a property key to an array of values (e.g. {\"status\":[\"Done\"]}); `unset` is an array of property keys to clear. Find keys with anytype_list_properties.",
    promptSnippet: "anytype_set_property — set/add/remove/unset a property (tag, status, …) on an object",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to modify." }),
      key: Type.String({ description: "The primary property key this call concerns." }),
      set: Type.Optional(
        Type.Record(Type.String(), Type.Array(Type.Unknown()), {
          description: "Map of property key -> values to set (replaces existing).",
        }),
      ),
      add: Type.Optional(
        Type.Record(Type.String(), Type.Array(Type.Unknown()), {
          description: "Map of property key -> values to add (e.g. add a tag).",
        }),
      ),
      remove: Type.Optional(
        Type.Record(Type.String(), Type.Array(Type.Unknown()), {
          description: "Map of property key -> values to remove.",
        }),
      ),
      unset: Type.Optional(
        Type.Array(Type.String(), { description: "Property keys to clear entirely." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const op: Record<string, unknown> = { op: "set_properties" };
        if (params.set) op.set = params.set;
        if (params.add) op.add = params.add;
        if (params.remove) op.remove = params.remove;
        if (params.unset) op.unset = params.unset;
        await api.patchObject(spaceId, params.id, [op]);
        const bits: string[] = [];
        if (params.set) bits.push(`set ${Object.keys(params.set).join(", ")}`);
        if (params.add) bits.push(`added to ${Object.keys(params.add).join(", ")}`);
        if (params.remove) bits.push(`removed from ${Object.keys(params.remove).join(", ")}`);
        if (params.unset) bits.push(`unset ${params.unset.join(", ")}`);
        return textResult(`Updated ${params.id}: ${bits.join("; ") || `property ${params.key}`}.`);
      } catch (err) {
        return textResult(`anytype_set_property failed: ${errMessage(err)}`);
      }
    },
  });

  const listProperties = defineTool({
    name: "anytype_list_properties",
    label: "List Anytype properties",
    description:
      "List the properties (fields) defined in the current Anytype space, with their name, format, and the `key` used to address them. Use the key with anytype_set_property.",
    promptSnippet: "anytype_list_properties — list the space's properties (name, format, key)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const props = await api.listProperties(spaceId);
        if (props.length === 0) return textResult("The space defines no properties.");
        const lines = props.map((p) => `${p.name || "(unnamed)"} (${p.format || "unknown"}) — ${p.key}`);
        return textResult(`${props.length} propert(ies) in the space:\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(`anytype_list_properties failed: ${errMessage(err)}`);
      }
    },
  });

  const createProperty = defineTool({
    name: "anytype_create_property",
    label: "Create Anytype property (tag)",
    description:
      "Create a new property in the current space. Use format `select` or `multi_select` for tags, and pass option names to predefine them. Returns the new property key.",
    promptSnippet: "anytype_create_property — create a property/tag (select/multi_select) in the space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "The property name (e.g. \"Priority\")." }),
      format: Type.Optional(
        Type.String({
          description:
            "Property format: text|number|select|multi_select|date|files|checkbox|url|email|phone|objects (default select).",
        }),
      ),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: "For select/multi_select: the option (tag) names to create.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const options = (params.options ?? []).map((name) => ({ name }));
        const { key } = await api.createProperty(spaceId, {
          name: params.name,
          format: params.format,
          options,
        });
        return textResult(`Created property "${params.name}" with key ${key}.`);
      } catch (err) {
        return textResult(`anytype_create_property failed: ${errMessage(err)}`);
      }
    },
  });

  const listTypes = defineTool({
    name: "anytype_list_types",
    label: "List Anytype types",
    description:
      "List the object types available in the current Anytype space (page, note, task, …), each with its key and name.",
    promptSnippet: "anytype_list_types — list the object types defined in the space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const types = await api.listTypes(spaceId);
        if (types.length === 0) return textResult("The space defines no types.");
        const lines = types.map((t) => `${t.name || "(unnamed)"} — ${t.key}`);
        return textResult(`${types.length} type(s) in the space:\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(`anytype_list_types failed: ${errMessage(err)}`);
      }
    },
  });

  const createCollection = defineTool({
    name: "anytype_create_collection",
    label: "Create Anytype collection",
    description:
      "Create a new collection in the current space, optionally seeded with existing object ids. Returns the new collection id.",
    promptSnippet: "anytype_create_collection — create a collection, optionally with object ids",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "The collection name." }),
      items: Type.Optional(
        Type.Array(Type.String(), { description: "Object ids to include in the collection." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const { id } = await api.createCollection(spaceId, { name: params.name, items: params.items });
        return textResult(`Created collection "${params.name}" with id ${id}.`);
      } catch (err) {
        return textResult(`anytype_create_collection failed: ${errMessage(err)}`);
      }
    },
  });

  const uploadFile = defineTool({
    name: "anytype_upload_file",
    label: "Upload a file to Anytype",
    description:
      "Upload a file into the current space, either from a remote URL or from a local file path. Returns the new file object id. Provide at least one of `url` or `path`.",
    promptSnippet: "anytype_upload_file — upload a file (from url or local path) into the space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "A remote http(s) URL to fetch and upload." })),
      path: Type.Optional(Type.String({ description: "A local file path to upload." })),
      name: Type.Optional(Type.String({ description: "Optional filename to store as." })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!params.url && !params.path) {
          return textResult("anytype_upload_file: provide a `url` or a `path`.");
        }
        const { id } = await api.uploadFile(spaceId, {
          url: params.url,
          path: params.path,
          name: params.name,
        });
        return textResult(`Uploaded file with id ${id}.`);
      } catch (err) {
        return textResult(`anytype_upload_file failed: ${errMessage(err)}`);
      }
    },
  });

  return [
    listObjects,
    search,
    readObject,
    downloadImages,
    cropImage,
    createNote,
    updateObject,
    deleteObject,
    setProperty,
    listProperties,
    createProperty,
    listTypes,
    createCollection,
    uploadFile,
  ] as ToolDefinition[];
}
