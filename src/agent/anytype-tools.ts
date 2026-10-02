import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import sharp from "sharp";
import type { AnytypeClient } from "../anytype/client.js";
import type { WatchRecord, WatchStore } from "../watch/store.js";
import { snapshotOf } from "../watch/store.js";
import { describeCron, parseCron } from "../watch/cron.js";
import { pollWatch } from "../watch/poller.js";
import { webSearch } from "./web-search.js";
import type { WebSearchResult } from "./web-search.js";
import { webFetch } from "./web-fetch.js";
import type { WebFetchFormat } from "./web-fetch.js";
import type { SubagentRegistry } from "./subagents.js";

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

/**
 * Resolve a space reference to an id. Empty → fallback. An exact id passes
 * through. Otherwise it is matched (exact, case-insensitive) against space
 * NAMES via listSpaces; no match → fallback. Never throws.
 */
export async function resolveSpaceId(
  api: AnytypeClient,
  value: string | undefined,
  fallback: string,
): Promise<string> {
  const v = (value ?? "").trim();
  if (v.length === 0) return fallback;
  try {
    const spaces = await api.listSpaces();
    if (spaces.some((s) => s.id === v)) return v;
    const lower = v.toLowerCase();
    const byName = spaces.find((s) => (s.name ?? "").toLowerCase() === lower);
    if (byName) return byName.id;
  } catch {
    // fall through to fallback
  }
  return fallback;
}

/** Build an AgentToolResult carrying a single text blob. */
function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Build an `insert_blocks` op. `before`/`after` name a precise slot and are
 * mutually exclusive with `position` (the API rejects the combination), so
 * `position` is only emitted when neither is given — defaulting to "last".
 */
function insertOp(
  markdown: string,
  pos: { before?: string; after?: string; position?: "first" | "last" } = {},
): Record<string, unknown> {
  const op: Record<string, unknown> = { op: "insert_blocks", markdown };
  if (pos.before !== undefined) op.before = pos.before;
  if (pos.after !== undefined) op.after = pos.after;
  if (pos.before === undefined && pos.after === undefined) op.position = pos.position ?? "last";
  return op;
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
      // The block id lets a later `anytype_update_block {block_id}` retarget
      // this image (e.g. repoint it after fixing EXIF orientation).
      const bid = typeof block.id === "string" ? block.id : "";
      return `![${label}](${oid})${bid ? ` [block:${bid}]` : ""}`;
    }
    case "file": {
      const label = typeof block.name === "string" && block.name.length > 0 ? block.name : "file";
      const oid = typeof block.object_id === "string" ? block.object_id : "";
      const bid = typeof block.id === "string" ? block.id : "";
      return `[${label}](${oid})${bid ? ` [block:${bid}]` : ""}`;
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

/**
 * Read every workspace's MEMORY.md under `root`: the global one (`_global/`)
 * plus each space dir. Returns [{spaceId, text}], skipping dirs without a
 * MEMORY.md and non-directory entries. Never throws.
 */
export function collectMemories(root: string): Array<{ spaceId: string; text: string }> {
  const out: Array<{ spaceId: string; text: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "MEMORY.md");
    try {
      out.push({ spaceId: e.name, text: fs.readFileSync(file, "utf-8") });
    } catch {
      // no MEMORY.md here — skip
    }
  }
  return out;
}

/** An object's display name, tolerating the post-patch 1-element array shape. */
function objectName(doc: unknown): string {
  if (doc === null || typeof doc !== "object") return "";
  const props = (doc as Record<string, unknown>).properties;
  if (props === null || typeof props !== "object") return "";
  const raw = (props as Record<string, unknown>).name;
  const s = Array.isArray(raw) ? raw[0] : raw;
  return typeof s === "string" ? s : "";
}

/** Common content types → the file extension we save a downloaded file as. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/xml": "xml",
  "application/json": "json",
  "application/xml": "xml",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Pick a file extension from a content type (parameters like charset stripped). */
function extForMime(mimeType: string): string {
  const m = mimeType.split(";")[0].trim().toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  if (m.startsWith("image/")) return m.slice("image/".length).replace(/[^a-z0-9]/g, "") || "img";
  if (m.startsWith("text/")) return m.slice("text/".length).replace(/[^a-z0-9]/g, "") || "txt";
  return "bin";
}

/**
 * Turn an object name into a safe single path component: strip path separators
 * and control characters, collapse whitespace, drop leading dots, cap the
 * length. Falls back to "file" when nothing usable remains.
 */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\/\\]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 80).trim() || "file";
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
async function resizeForModel(buf: Buffer): Promise<{ data: string; mimeType: string } | null> {
  // Don't gate on the response Content-Type: a file-object's download may omit
  // it (or send application/octet-stream). Let sharp sniff the real format — a
  // non-image simply fails and is skipped.
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
  "When the user asks to be notified/watched when a note or object changes (e.g. \"订阅\", \"watch\", \"notify me when it changes\"), use `anytype_watch` with action \"add\" and the object id. The bot then polls the object and posts a notification into this chat whenever its content changes.",
  "当用户想定时检查（如'每天/每小时/每天早上9点'）时，用 `anytype_watch` 的 `cron` 参数设置 5 段 cron（分 时 日 月 周）；例如 每天早上9点=`0 9 * * *`，每小时=`0 * * * *`，每30分钟=`*/30 * * * *`。",
  "`anytype_watch` 的 `prompt` 参数可让 AI 在对象每次变化时执行一条指令（例如『总结这篇文章的变化』『检查未完成待办并提醒我』）：届时 AI 会先读取该对象、再按指令处理，并把结果发到聊天。用户想要摘要/检查/动作而非原始 diff 时，就设置 `prompt`。",
  "The space may contain loose files (PDF, docx, xlsx, txt, …) not inside any page — find them with `anytype_list_objects {type:\"file\"}` (or the relevant type). To READ one: `anytype_download_file {id}` saves it locally, then use your shell tools to extract text (pdftotext / unzip / python3 / cat). Images you can already SEE via anytype_read_object.",
];

/** Extra guideline for the anytype_download_file tool (the rest are the shared identity ones). */
const DOWNLOAD_FILE_GUIDELINE =
  "For a loose non-image file (PDF/docx/xlsx/txt/…), call `anytype_download_file` to save it locally, then read it with your shell tools (pdftotext, unzip -p, python3, cat).";

/** Extra guideline for the web_search tool (the rest are the shared identity ones). */
const WEB_SEARCH_GUIDELINE =
  "Use `web_search` for current events / facts you're unsure about; cite the returned sources.";

/** Extra guideline for the web_fetch tool (the rest are the shared identity ones). */
const WEB_FETCH_GUIDELINE =
  "Use `web_fetch` to read the full content of a specific page (e.g. a URL returned by web_search); " +
  "it renders with a real JS-capable headless browser and returns readable text (default Markdown).";

/** Maps a user-facing `format` param to Lightpanda's dump mode (default markdown). */
function toFetchFormat(raw: unknown): WebFetchFormat {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  switch (v) {
    case "html": return "html";
    case "text": return "semantic_tree_text";
    case "semantic": return "semantic_tree";
    case "markdown": return "markdown";
    default: return "markdown";
  }
}

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
  /** Durable set of object-change subscriptions (anytype_watch). */
  store: WatchStore;
  /** The chat this session belongs to — watch notifications are sent back here. */
  chatId: string;
  /** Cron applied to new watches that don't specify one (env WATCH_DEFAULT_CRON). */
  defaultWatchCron: string;
  /** Called after a watch is added/removed (e.g. to trigger an immediate poll). */
  onWatchChange?: () => void;
  /** DeepSeek key backing the `web_search` tool (env DEEPSEEK_API_KEY). Empty disables it. */
  searchApiKey: string;
  /** Model id for `web_search` (env SEARCH_MODEL). Defaults to the search fn's own default. */
  searchModel?: string;
  /** Max number of searches `web_search` may run (default 3). */
  searchMaxUses?: number;
  /** Search implementation (defaults to the real DeepSeek web search; injectable for tests). */
  searchFn?: typeof webSearch;
  /** Lightpanda binary for `web_fetch` (env LIGHTPANDA_BIN). Default "lightpanda". */
  lightpandaBin?: string;
  /** Timeout (ms) for a `web_fetch` run (env WEB_FETCH_TIMEOUT_MS). Default 30000. */
  webFetchTimeoutMs?: number;
  /** Max characters returned by `web_fetch` (env WEB_FETCH_MAX_CHARS). Default 20000. */
  webFetchMaxChars?: number;
  /** Web-fetch implementation (defaults to the Lightpanda-backed webFetch; injectable for tests). */
  runFetch?: (opts: { url: string; format?: string; strip?: string }) => Promise<{ text: string }>;
  /**
   * When set, adds a `subagent` tool that delegates a self-contained task to a
   * fresh, isolated session and returns its final text. Absent for child
   * sessions, so they cannot spawn further sub-agents.
   */
  runSubagent?: (task: string) => Promise<string>;
  /**
   * When set, adds an `agent` tool for persistent, named sub-agents the parent
   * can spawn once and then message repeatedly. Absent for child sessions, so
   * they cannot create further agents.
   */
  agentRegistry?: SubagentRegistry;
  /**
   * When set, this session is the GLOBAL CONSOLE: cross-space read tools and
   * the memory aggregate are registered. Absent for normal sessions, which
   * stay confined to `spaceId`.
   */
  console?: {
    /** Root dir holding per-space workspaces (`/workspace`). */
    workspaceRoot: string;
    /**
     * Join a space / connect the 1:1 console from a user-shared link. Provided
     * by main; absent in contexts that cannot perform the join.
     */
    joinSpace?: (link: string) => Promise<{ ok: boolean; message: string }>;
  };
}): ToolDefinition[] {
  const {
    api,
    spaceId,
    workspaceDir,
    store,
    chatId,
    defaultWatchCron,
    onWatchChange,
    searchApiKey,
    searchModel,
    searchMaxUses,
    searchFn = webSearch,
    lightpandaBin = "lightpanda",
    webFetchTimeoutMs = 30000,
    webFetchMaxChars = 20000,
    runFetch,
    runSubagent,
    agentRegistry,
    console: consoleDep,
  } = deps;

  /** The effective web-fetch impl: an injected one, else the Lightpanda-backed default. */
  const runFetchImpl =
    runFetch ??
    ((o: { url: string; format?: string; strip?: string }) =>
      webFetch({
        url: o.url,
        format: o.format as WebFetchFormat | undefined,
        strip: o.strip,
        bin: lightpandaBin,
        timeoutMs: webFetchTimeoutMs,
        maxChars: webFetchMaxChars,
      }));

  /** Message shown when a cron expression fails validation. */
  const CRON_HELP =
    "cron 表达式无效。格式为 5 段（分 时 日 月 周），例如 每天早上9点=`0 9 * * *`，" +
    "每小时=`0 * * * *`，每30分钟=`*/30 * * * *`。";

  /** Where a page's downloaded images live. */
  const imagesDirFor = (objectId: string): string =>
    path.join(workspaceDir, "images", objectId.slice(0, 24));

  const listObjects = defineTool({
    name: "anytype_list_objects",
    label: "List Anytype objects",
    description:
      "List the objects (notes, pages, images, files, tasks, …) in the current Anytype space. " +
      "With `type` set, lists every object of that type — e.g. `type:\"image\"` reveals the images " +
      "in the space (including loose images NOT placed in any page, which the default list hides); " +
      "`type:\"file\"` lists loose files; `type:\"task\"` lists tasks. Use the default (no type) for " +
      "pages/notes. To see one image's content, pass its id to anytype_read_object.",
    promptSnippet: "anytype_list_objects — list objects; pass type:\"image\"/\"file\" to find loose images/files",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      type: Type.Optional(
        Type.String({
          description:
            "Optional object type key to list (e.g. \"image\", \"file\", \"task\", \"page\"). Reveals loose objects of that type.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Optional maximum number of objects to return." })),
      ...(consoleDep
        ? { space: Type.Optional(Type.String({ description: "Optional space id or name to read from (default: the current space)." })) }
        : {}),
    }),
    async execute(_toolCallId, params) {
      try {
        const target = await resolveSpaceId(api, consoleDep ? (params as { space?: string }).space : undefined, spaceId);
        const type = typeof params.type === "string" ? params.type.trim() : "";
        // Explicit type → enumerate that type (reveals loose files/images).
        // Default → the space's content objects (loose files are omitted).
        let items = type
          ? await api.listObjectsOfType(target, type)
          : (await api.listObjects(target)).filter(isContentObject);
        if (typeof params.limit === "number" && params.limit >= 0) items = items.slice(0, params.limit);
        const label = type ? `${type} object(s)` : "object(s) in the space";
        return textResult(`${items.length} ${label}:\n${renderList(items)}`);
      } catch (err) {
        return textResult(`anytype_list_objects failed: ${errMessage(err)}`);
      }
    },
  });

  const search = defineTool({
    name: "anytype_search",
    label: "Search Anytype",
    description:
      "Search the current Anytype space by text query and/or structured filters. Use `query` to find notes/pages by title or content. Use `filters` for precise, field-based queries: a recursive FilterNode tree, e.g. [{\"condition\":\"in\",\"property\":\"tag\",\"value\":[\"重要\"]}] or a group {\"operator\":\"and\",\"filters\":[...]}. Either `query` or `filters` may be given (at least one is required).",
    promptSnippet: "anytype_search — search the space by text query and/or structured filters",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "The search text (optional if `filters` is given)." })),
      filters: Type.Optional(
        Type.Unknown({
          description:
            "A FilterNode[] (or group) for field-based filtering, passed through to the API as `filters`.",
        }),
      ),
      ...(consoleDep
        ? { space: Type.Optional(Type.String({ description: "Optional space id or name to read from (default: the current space)." })) }
        : {}),
    }),
    async execute(_toolCallId, params) {
      try {
        const target = await resolveSpaceId(api, consoleDep ? (params as { space?: string }).space : undefined, spaceId);
        const hasFilters = params.filters !== undefined;
        const query = params.query ?? "";
        if (!hasFilters && query.length === 0) {
          return textResult("anytype_search: provide a `query` and/or `filters`.");
        }
        const items = hasFilters
          ? await api.filteredSearch(target, { query, filters: params.filters })
          : await api.search(target, query);
        const filtered = items.filter(isContentObject);
        const label = hasFilters
          ? `${query.length > 0 ? `"${query}" ` : ""}filters ${JSON.stringify(params.filters)}`
          : `"${query}"`;
        return textResult(`Search results for ${label}:\n${renderList(filtered)}`);
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
      ...(consoleDep
        ? { space: Type.Optional(Type.String({ description: "Optional space id or name to read from (default: the current space)." })) }
        : {}),
    }),
    async execute(_toolCallId, params) {
      try {
        const target = await resolveSpaceId(api, consoleDep ? (params as { space?: string }).space : undefined, spaceId);
        const doc = await api.getObjectRaw(target, params.id);
        const content: Content[] = [{ type: "text", text: renderObject(doc) }];

        // Attach the page's images so the (multimodal) model can actually see
        // them. Download, downscale, and send as image content.
        const images = extractImages(doc);
        const chosen = images.slice(0, MAX_IMAGES_PER_READ);
        for (const img of chosen) {
          try {
            const { data } = await api.downloadFileContent(target, img.objectId);
            const resized = await resizeForModel(data);
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
      "Create a new page/note in the current Anytype space with a title and optional markdown body. Markdown supports tables (e.g. `| A | B |\\n| --- | --- |\\n| 1 | 2 |`). Optionally pass `template_id` (from anytype_templates) so the new object starts from that template's content. Returns the new object id.",
    promptSnippet: "anytype_create_note — create a new page/note (optionally from a template) in the space",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "The title of the new note." }),
      markdown: Type.Optional(Type.String({ description: "Optional markdown body (tables are supported)." })),
      template_id: Type.Optional(
        Type.String({ description: "Optional template id (from anytype_templates) to start the object from." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const created = await api.createObject(spaceId, {
          name: params.name,
          markdown: params.markdown,
          templateId: params.template_id,
        });
        const from = params.template_id ? ` from template ${params.template_id}` : "";
        return textResult(`Created note "${params.name}"${from} with id ${created.id}`);
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

  const downloadFile = defineTool({
    name: "anytype_download_file",
    label: "Download a file object",
    description:
      "Download ANY file object (a loose PDF, docx, xlsx, txt, …) into the local workspace and return its path. " +
      "Use this to read non-image files: after downloading, extract the text with your shell tools. " +
      "For images, prefer anytype_read_object — you can already SEE those.",
    promptSnippet: "anytype_download_file — save any file object locally, then extract text with your shell tools",
    promptGuidelines: [...GUIDELINES, DOWNLOAD_FILE_GUIDELINE],
    parameters: Type.Object({
      id: Type.String({ description: "The file object id to download." }),
      name: Type.Optional(
        Type.String({ description: "Fallback name to use if the object itself has no name." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        // Learn the display name from the object doc; fall back to params.name/id.
        let name = params.name?.trim() ?? "";
        try {
          const doc = await api.getObjectRaw(spaceId, params.id);
          const docName = objectName(doc);
          if (docName) name = docName;
        } catch {
          // A file object's doc may be unreadable — the download can still work.
        }
        const { data, mimeType } = await api.downloadFileContent(spaceId, params.id);
        const ext = extForMime(mimeType);
        const file = `${sanitizeName(name || params.id)}-${params.id.slice(0, 8)}.${ext}`;
        const dir = path.join(workspaceDir, "files");
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, file);
        fs.writeFileSync(dest, data);
        return textResult(
          `Saved to ${dest}  (${mimeType}, ${data.length} bytes)\n` +
            "Read it with your shell tools: `cat`/`head` for text, `file` to detect, `pdftotext` for PDFs, " +
            "`unzip -p` (or python3 zipfile+xml) for docx/xlsx, `strings`/`xxd` for unknown binaries. " +
            "Images: prefer anytype_read_object (you get to SEE them).",
        );
      } catch (err) {
        return textResult(`anytype_download_file failed: ${errMessage(err)}`);
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
      "Edit an existing Anytype object: rename it and/or insert markdown into its body. Provide at least one of `name` (new title) or `append_markdown` (markdown inserted as new content). By default the markdown is appended at the end; pass `before` or `after` (a block id) to insert it at a precise position instead (the two are mutually exclusive). Markdown tables work (e.g. `| A | B |\\n| --- | --- |\\n| 1 | 2 |`).",
    promptSnippet: "anytype_update_object — rename an object and/or insert markdown (optionally before/after a block)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to update." }),
      name: Type.Optional(Type.String({ description: "New title for the object." })),
      append_markdown: Type.Optional(
        Type.String({ description: "Markdown to insert into the object's body (tables supported)." }),
      ),
      before: Type.Optional(
        Type.String({ description: "Insert the markdown immediately before this block id (instead of appending)." }),
      ),
      after: Type.Optional(
        Type.String({ description: "Insert the markdown immediately after this block id (instead of appending)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const ops: unknown[] = [];
        if (params.name !== undefined) {
          ops.push({ op: "set_properties", set: { name: [params.name] } });
        }
        if (params.append_markdown !== undefined) {
          ops.push(insertOp(params.append_markdown, { before: params.before, after: params.after }));
        }
        if (ops.length === 0) {
          return textResult("anytype_update_object: provide `name` and/or `append_markdown`.");
        }
        await api.patchObject(spaceId, params.id, ops);
        const parts: string[] = [];
        if (params.name !== undefined) parts.push(`renamed to "${params.name}"`);
        if (params.append_markdown !== undefined) parts.push("inserted markdown");
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
        const lines = types.map(
          (t) => `${t.name || "(unnamed)"}${t.layout ? ` (${t.layout})` : ""} — ${t.key}`,
        );
        return textResult(`${types.length} type(s) in the space:\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(`anytype_list_types failed: ${errMessage(err)}`);
      }
    },
  });

  const createType = defineTool({
    name: "anytype_create_type",
    label: "Create Anytype type",
    description:
      "Create a new object type in the current space. `name` is the singular display name. " +
      "`layout` is one of: basic, note, todo, profile, bookmark, set, collection. " +
      "`properties` is the type's whole field list — property names (an unknown name is created). " +
      "Returns the new type's key (use it with anytype_create_note's `type`).",
    promptSnippet: "anytype_create_type — create an object type (name, layout, icon, properties)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "The type's singular display name." }),
      plural_name: Type.Optional(Type.String({ description: "Optional plural display name." })),
      layout: Type.Optional(
        Type.String({
          description: "One of: basic, note, todo, profile, bookmark, set, collection (default basic).",
        }),
      ),
      icon_emoji: Type.Optional(Type.String({ description: "Optional emoji icon, e.g. \"🌟\"." })),
      properties: Type.Optional(
        Type.Array(Type.String(), {
          description: "The type's field list: property names (unknown names are minted).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const { key } = await api.createType(spaceId, {
          name: params.name,
          pluralName: params.plural_name,
          layout: params.layout,
          iconEmoji: params.icon_emoji,
          properties: params.properties,
        });
        return textResult(`已创建类型「${params.name}」(key: ${key})`);
      } catch (err) {
        return textResult(`anytype_create_type failed: ${errMessage(err)}`);
      }
    },
  });

  const updateType = defineTool({
    name: "anytype_update_type",
    label: "Update Anytype type",
    description:
      "Update an existing object type by its `key` (from anytype_list_types). Provide at least one field to change: " +
      "`name` (rename), `plural_name`, `layout` (basic|note|todo|profile|bookmark|set|collection), " +
      "`icon_emoji`, or `default_view` (table|list|gallery|kanban|calendar|graph).",
    promptSnippet: "anytype_update_type — rename/relayout an object type by key",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      key: Type.String({ description: "The type key to update (from anytype_list_types)." }),
      name: Type.Optional(Type.String({ description: "New singular display name." })),
      plural_name: Type.Optional(Type.String({ description: "New plural display name." })),
      layout: Type.Optional(
        Type.String({ description: "New layout: basic|note|todo|profile|bookmark|set|collection." }),
      ),
      icon_emoji: Type.Optional(Type.String({ description: "New emoji icon, e.g. \"🌟\"." })),
      default_view: Type.Optional(
        Type.String({ description: "New default view: table|list|gallery|kanban|calendar|graph." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const hasField =
          params.name !== undefined ||
          params.plural_name !== undefined ||
          params.layout !== undefined ||
          params.icon_emoji !== undefined ||
          params.default_view !== undefined;
        if (!hasField) {
          return textResult(
            "anytype_update_type: provide at least one of name, plural_name, layout, icon_emoji, default_view.",
          );
        }
        await api.updateType(spaceId, params.key, {
          name: params.name,
          pluralName: params.plural_name,
          layout: params.layout,
          iconEmoji: params.icon_emoji,
          defaultView: params.default_view,
        });
        return textResult(`已更新类型 ${params.key}。`);
      } catch (err) {
        return textResult(`anytype_update_type failed: ${errMessage(err)}`);
      }
    },
  });

  const deleteType = defineTool({
    name: "anytype_delete_type",
    label: "Delete Anytype type",
    description:
      "Delete an object type by its `key` (from anytype_list_types). This is permanent — confirm the key first.",
    promptSnippet: "anytype_delete_type — permanently delete an object type by key",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      key: Type.String({ description: "The type key to delete." }),
    }),
    async execute(_toolCallId, params) {
      try {
        await api.deleteType(spaceId, params.key);
        return textResult(`已删除类型 ${params.key}。`);
      } catch (err) {
        return textResult(`anytype_delete_type failed: ${errMessage(err)}`);
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

  const editObject = defineTool({
    name: "anytype_edit_object",
    label: "Edit Anytype object text",
    description:
      "Replace an exact text `find` with `replace` inside an object's body. The `find` text must match exactly one block (pass `replace_all:true` to replace every occurrence across multiple blocks).",
    promptSnippet: "anytype_edit_object — replace an exact text `find` with `replace` inside a note",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to edit." }),
      find: Type.String({ description: "The exact text to find (must match exactly one block)." }),
      replace: Type.String({ description: "The replacement text." }),
      replace_all: Type.Optional(
        Type.Boolean({ description: "Replace every occurrence, allowing the find to match multiple blocks." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const op: Record<string, unknown> = { op: "replace_text", find: params.find, replace: params.replace };
        if (params.replace_all !== undefined) op.replace_all = params.replace_all;
        await api.patchObject(spaceId, params.id, [op]);
        return textResult(`Replaced "${params.find}" with "${params.replace}" in ${params.id}.`);
      } catch (err) {
        return textResult(`anytype_edit_object failed: ${errMessage(err)}`);
      }
    },
  });

  const updateBlock = defineTool({
    name: "anytype_update_block",
    label: "Update Anytype block",
    description:
      "Change fields of a single block inside an object. `id` is the object id; target the block by its exact text `match` (or by `block_id`). `set` is a JSON object of the fields to change, e.g. {\"checked\":true} to tick a checkbox or {\"text\":\"new\"} to rewrite it. Provide the object `id` and at least one of `match` or `block_id`.",
    promptSnippet: "anytype_update_block — change a block's fields (e.g. {\"checked\":true}) by text match or block id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id containing the block." }),
      match: Type.Optional(Type.String({ description: "Exact text of the block to update." })),
      block_id: Type.Optional(Type.String({ description: "The block id to update (alternative to `match`)." })),
      set: Type.Record(Type.String(), Type.Unknown(), {
        description: "Map of block fields to set, e.g. {\"checked\":true}.",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.match === undefined && params.block_id === undefined) {
          return textResult("anytype_update_block: provide `match` or `block_id`.");
        }
        const op: Record<string, unknown> = { op: "update_block", set: params.set };
        if (params.block_id !== undefined) op.id = params.block_id;
        if (params.match !== undefined) op.match = params.match;
        await api.patchObject(spaceId, params.id, [op]);
        const target = params.block_id !== undefined ? `block id ${params.block_id}` : `match "${params.match}"`;
        return textResult(`Updated block (${target}) with ${JSON.stringify(params.set)}.`);
      } catch (err) {
        return textResult(`anytype_update_block failed: ${errMessage(err)}`);
      }
    },
  });

  const deleteBlock = defineTool({
    name: "anytype_delete_block",
    label: "Delete Anytype block",
    description:
      "Delete a single block inside an object. `id` is the object id; target the block by its exact text `match` (or by `block_id`). Set `recursive:true` to also delete the block's children. Provide the object `id` and at least one of `match` or `block_id`.",
    promptSnippet: "anytype_delete_block — delete a block (and optionally its children) by text match or block id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id containing the block." }),
      match: Type.Optional(Type.String({ description: "Exact text of the block to delete." })),
      block_id: Type.Optional(Type.String({ description: "The block id to delete (alternative to `match`)." })),
      recursive: Type.Optional(Type.Boolean({ description: "Also delete nested child blocks (default false)." })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.match === undefined && params.block_id === undefined) {
          return textResult("anytype_delete_block: provide `match` or `block_id`.");
        }
        const op: Record<string, unknown> = { op: "delete_block" };
        if (params.block_id !== undefined) op.id = params.block_id;
        if (params.match !== undefined) op.match = params.match;
        if (params.recursive !== undefined) op.recursive = params.recursive;
        await api.patchObject(spaceId, params.id, [op]);
        const target = params.block_id !== undefined ? `block id ${params.block_id}` : `match "${params.match}"`;
        return textResult(`Deleted block (${target}).`);
      } catch (err) {
        return textResult(`anytype_delete_block failed: ${errMessage(err)}`);
      }
    },
  });

  const collectionItems = defineTool({
    name: "anytype_collection_items",
    label: "Add/remove collection items",
    description:
      "Add and/or remove objects from an existing collection. `add` and `remove` are arrays of object ids. Provide at least one of them.",
    promptSnippet: "anytype_collection_items — add/remove object ids from a collection",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      collection_id: Type.String({ description: "The collection object id." }),
      add: Type.Optional(Type.Array(Type.String(), { description: "Object ids to add to the collection." })),
      remove: Type.Optional(Type.Array(Type.String(), { description: "Object ids to remove from the collection." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const ops: unknown[] = [];
        if (params.add && params.add.length > 0) ops.push({ op: "add_items", items: params.add });
        if (params.remove && params.remove.length > 0) ops.push({ op: "remove_items", items: params.remove });
        if (ops.length === 0) {
          return textResult("anytype_collection_items: provide `add` and/or `remove`.");
        }
        await api.patchObject(spaceId, params.collection_id, ops);
        const bits: string[] = [];
        if (params.add && params.add.length > 0) bits.push(`added ${params.add.length}`);
        if (params.remove && params.remove.length > 0) bits.push(`removed ${params.remove.length}`);
        return textResult(`Updated collection ${params.collection_id}: ${bits.join(", ")}.`);
      } catch (err) {
        return textResult(`anytype_collection_items failed: ${errMessage(err)}`);
      }
    },
  });

  const watch = defineTool({
    name: "anytype_watch",
    label: "Subscribe to object changes",
    description:
      "Subscribe this chat to changes on an Anytype object (a note/page). Each subscription has a cron schedule; the bot checks the object on that schedule (local time) and posts a notification into this chat when its content changes. Actions: \"add\" (with `id`, optional `cron`/`prompt`/`label`) to subscribe; \"schedule\" (with `id` and at least one of `cron`/`prompt`) to change the schedule or instruction of an existing subscription; \"check\" (with `id`) to check it right now; \"remove\" (with `id`) to unsubscribe; \"list\" to show the space's current subscriptions. Subscriptions survive restarts.",
    promptSnippet: "anytype_watch — subscribe to (or list/schedule/check/remove) notifications when an object changes",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      action: Type.String({ description: "One of: add, remove, list, schedule, check." }),
      id: Type.Optional(Type.String({ description: "The object id (required for add/remove/schedule/check)." })),
      label: Type.Optional(Type.String({ description: "Optional human label for the subscription." })),
      cron: Type.Optional(
        Type.String({
          description:
            "5-field cron schedule (minute hour day-of-month month day-of-week), local time. Examples: 每天早上9点=`0 9 * * *`, 每小时=`0 * * * *`, 每30分钟=`*/30 * * * *`. Required for schedule unless `prompt` is given; optional for add (defaults to the configured default).",
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "当对象变化时让 AI 执行的指令，例如『总结这篇文章的变化』；不填则只通知改了哪些地方",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "add") {
          if (!params.id) return textResult("anytype_watch: `id` is required for action \"add\".");
          const cron = params.cron ?? defaultWatchCron;
          if (!parseCron(cron)) return textResult(`anytype_watch: ${CRON_HELP}`);
          const doc = await api.getObjectRaw(spaceId, params.id);
          const label = params.label ?? objectName(doc);
          const name = label || params.id;
          const record: WatchRecord = {
            objectId: params.id,
            spaceId,
            chatId,
            label: name,
            snapshot: snapshotOf(doc),
            cron,
          };
          const prompt = params.prompt?.trim();
          if (prompt) record.prompt = prompt;
          store.upsert(record);
          store.save();
          onWatchChange?.();
          const promptNote = prompt ? `，变化时按指令处理：${prompt}` : "";
          return textResult(`已订阅『${name}』，将${describeCron(cron)}检查${promptNote}；可通过 schedule 修改`);
        }
        if (params.action === "remove") {
          if (!params.id) return textResult("anytype_watch: `id` is required for action \"remove\".");
          const existed = store.remove(spaceId, params.id);
          if (existed) {
            store.save();
            onWatchChange?.();
            return textResult(`已取消订阅 ${params.id}。`);
          }
          return textResult(`没有找到该订阅（id ${params.id}）。`);
        }
        if (params.action === "schedule") {
          if (!params.id) return textResult("anytype_watch: `id` is required for action \"schedule\".");
          const hasCron = params.cron !== undefined;
          const hasPrompt = params.prompt !== undefined;
          if (!hasCron && !hasPrompt) {
            return textResult("anytype_watch: 请至少提供 `cron` 或 `prompt` 之一。");
          }
          if (hasCron && !parseCron(params.cron as string)) return textResult(`anytype_watch: ${CRON_HELP}`);
          const rec = store.get(spaceId, params.id);
          if (!rec) return textResult(`没有找到该订阅（id ${params.id}）。`);
          const parts: string[] = [];
          if (hasCron) {
            rec.cron = params.cron as string;
            rec.lastFiredMinute = undefined;
            parts.push(`检查计划改为${describeCron(params.cron as string)}（${params.cron}）`);
          }
          if (hasPrompt) {
            const prompt = params.prompt?.trim();
            if (prompt) {
              rec.prompt = prompt;
              parts.push(`变化指令改为：${prompt}`);
            } else {
              delete rec.prompt;
              parts.push("已清除变化指令（变化时仅通知差异）");
            }
          }
          store.save();
          onWatchChange?.();
          return textResult(`已更新『${rec.label}』：${parts.join("；")}。`);
        }
        if (params.action === "check") {
          if (!params.id) return textResult("anytype_watch: `id` is required for action \"check\".");
          const rec = store.get(spaceId, params.id);
          if (!rec) return textResult(`没有找到该订阅（id ${params.id}）。`);
          const before = JSON.stringify(rec.snapshot);
          // Capture the change summary locally instead of running the watch
          // dispatcher: `check` is synchronous and must NOT spawn a nested
          // agent. The agent reports the outcome in its own reply.
          let summary = "";
          await pollWatch(rec, {
            store,
            api,
            notify: async (_r, text) => {
              summary = text;
            },
          });
          if (!store.get(spaceId, params.id)) {
            return textResult(`已检查『${rec.label}』：对象已不存在，已取消订阅。`);
          }
          const changed = JSON.stringify(rec.snapshot) !== before;
          return textResult(
            changed
              ? `已检查『${rec.label}』：内容有更新。\n${summary}`
              : `已检查『${rec.label}』：内容没有变化。`,
          );
        }
        if (params.action === "list") {
          const records = store.forSpace(spaceId);
          if (records.length === 0) return textResult("当前没有任何订阅。");
          const lines = records.map((r, i) => {
            const p = r.prompt?.trim();
            const promptNote = p ? ` · 指令：${p.length > 30 ? `${p.slice(0, 30)}…` : p}` : "";
            return `${i + 1}. 『${r.label}』 — ${describeCron(r.cron ?? "")} — ${r.objectId}${promptNote}`;
          });
          return textResult(`${records.length} 个订阅：\n${lines.join("\n")}`);
        }
        return textResult(
          `anytype_watch: unknown action "${params.action}" (use add, remove, list, schedule, or check).`,
        );
      } catch (err) {
        return textResult(`anytype_watch failed: ${errMessage(err)}`);
      }
    },
  });

  const sendMessage = defineTool({
    name: "anytype_send_message",
    label: "Send a chat message",
    description:
      "Send a text message into the CURRENT chat (the one this conversation is happening in). Use this to post something into the chat proactively — e.g. a summary or a follow-up — rather than as a reply.",
    promptSnippet: "anytype_send_message — post a message into the current chat",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      text: Type.String({ description: "The message text to send." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const key = `chat-${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await api.sendMessage(spaceId, chatId, params.text, key);
        return textResult(`Sent message to the current chat (${chatId}).`);
      } catch (err) {
        return textResult(`anytype_send_message failed: ${errMessage(err)}`);
      }
    },
  });

  const react = defineTool({
    name: "anytype_react",
    label: "React to a chat message",
    description:
      "Add an emoji reaction to a message in the CURRENT chat. Pass the message id (from a chat read) and the emoji, e.g. \"👍\".",
    promptSnippet: "anytype_react — add an emoji reaction to a message in the current chat",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      message_id: Type.String({ description: "The id of the message to react to." }),
      emoji: Type.String({ description: "The emoji to react with, e.g. \"👍\"." }),
    }),
    async execute(_toolCallId, params) {
      try {
        await api.reactToMessage(spaceId, chatId, params.message_id, params.emoji);
        return textResult(`Reacted ${params.emoji} to message ${params.message_id}.`);
      } catch (err) {
        return textResult(`anytype_react failed: ${errMessage(err)}`);
      }
    },
  });

  const editMessage = defineTool({
    name: "anytype_edit_message",
    label: "Edit a chat message",
    description:
      "Edit the text of an existing message in the CURRENT chat, in place. Pass the message id and the new `text`.",
    promptSnippet: "anytype_edit_message — edit the text of a message in the current chat",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      message_id: Type.String({ description: "The id of the message to edit." }),
      text: Type.String({ description: "The new message text." }),
    }),
    async execute(_toolCallId, params) {
      try {
        await api.editMessage(spaceId, chatId, params.message_id, params.text);
        return textResult(`Edited message ${params.message_id}.`);
      } catch (err) {
        return textResult(`anytype_edit_message failed: ${errMessage(err)}`);
      }
    },
  });

  const deleteMessage = defineTool({
    name: "anytype_delete_message",
    label: "Delete a chat message",
    description:
      "Delete a message from the CURRENT chat by id. This is permanent — confirm the message id first.",
    promptSnippet: "anytype_delete_message — delete a message from the current chat by id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      message_id: Type.String({ description: "The id of the message to delete." }),
    }),
    async execute(_toolCallId, params) {
      try {
        await api.deleteMessage(spaceId, chatId, params.message_id);
        return textResult(`Deleted message ${params.message_id}.`);
      } catch (err) {
        return textResult(`anytype_delete_message failed: ${errMessage(err)}`);
      }
    },
  });

  const templates = defineTool({
    name: "anytype_templates",
    label: "Manage Anytype templates",
    description:
      "Manage templates in the current space. Actions: \"list\" (optional `type` to filter by a type key), \"create\" (needs `name` + `type`, and a `markdown` body), \"delete\" (needs `template_id`). Use a template's id with anytype_create_note's `template_id` to start a new object from it.",
    promptSnippet: "anytype_templates — list/create/delete templates; apply one via anytype_create_note",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      action: Type.String({ description: "One of: list, create, delete." }),
      type: Type.Optional(Type.String({ description: "Object type key (e.g. \"page\") — for list filtering and create." })),
      name: Type.Optional(Type.String({ description: "Template name (required for create)." })),
      markdown: Type.Optional(Type.String({ description: "Template body as markdown (for create; tables supported)." })),
      template_id: Type.Optional(Type.String({ description: "The template id to delete (required for delete)." })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "list") {
          const list = await api.listTemplates(spaceId, params.type);
          if (list.length === 0) return textResult("The space has no templates.");
          const lines = list.map(
            (t) => `${t.name || "(untitled)"} (${t.templateFor || "?"})${t.isDefault ? " [default]" : ""} — ${t.id}`,
          );
          return textResult(`${list.length} template(s):\n${lines.join("\n")}`);
        }
        if (params.action === "create") {
          if (!params.name) return textResult("anytype_templates: `name` is required for action \"create\".");
          if (!params.type) return textResult("anytype_templates: `type` is required for action \"create\".");
          const { id } = await api.createTemplate(spaceId, {
            name: params.name,
            typeKey: params.type,
            markdown: params.markdown,
          });
          return textResult(`Created template "${params.name}" for type ${params.type} with id ${id}.`);
        }
        if (params.action === "delete") {
          if (!params.template_id) {
            return textResult("anytype_templates: `template_id` is required for action \"delete\".");
          }
          await api.deleteTemplate(spaceId, params.template_id);
          return textResult(`Deleted template ${params.template_id}.`);
        }
        return textResult(`anytype_templates: unknown action "${params.action}" (use list, create, or delete).`);
      } catch (err) {
        return textResult(`anytype_templates failed: ${errMessage(err)}`);
      }
    },
  });

  const insertMarkdown = defineTool({
    name: "anytype_insert_markdown",
    label: "Insert markdown at a position",
    description:
      "Insert markdown into an object at a precise position. `id` is the object id. By default the markdown is appended at the end (`position` \"last\"); pass `position` \"first\" to prepend, or `before`/`after` (a block id) to insert relative to an existing block (`before`/`after` are mutually exclusive with `position`). Markdown tables work, e.g. `| A | B |\\n| --- | --- |\\n| 1 | 2 |`.",
    promptSnippet: "anytype_insert_markdown — insert markdown into an object at first/last or before/after a block",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to insert into." }),
      markdown: Type.String({ description: "The markdown to insert (tables supported)." }),
      before: Type.Optional(Type.String({ description: "Insert immediately before this block id." })),
      after: Type.Optional(Type.String({ description: "Insert immediately after this block id." })),
      position: Type.Optional(
        Type.String({ description: "Where to insert when no before/after is given: \"first\" or \"last\" (default last)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const position = params.position === "first" ? "first" : params.position === "last" ? "last" : undefined;
        const op = insertOp(params.markdown, { before: params.before, after: params.after, position });
        await api.patchObject(spaceId, params.id, [op]);
        const where =
          params.before !== undefined
            ? `before ${params.before}`
            : params.after !== undefined
              ? `after ${params.after}`
              : position === "first"
                ? "at the start"
                : "at the end";
        return textResult(`Inserted markdown ${where} of object ${params.id}.`);
      } catch (err) {
        return textResult(`anytype_insert_markdown failed: ${errMessage(err)}`);
      }
    },
  });

  const webSearchTool = defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for current information (news, recent facts, anything outside the Anytype space or your knowledge). Returns a short answer plus the sources it used. Use this for current events or facts you're unsure about, and cite the returned sources.",
    promptSnippet: "web_search — search the web for current events / facts and cite the returned sources",
    promptGuidelines: [...GUIDELINES, WEB_SEARCH_GUIDELINE],
    parameters: Type.Object({
      query: Type.String({ description: "The search query or question to look up on the web." }),
      max_uses: Type.Optional(
        Type.Number({ description: "Maximum number of web searches to run (default 3)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (searchApiKey.length === 0) {
        return textResult("web search is not configured (set DEEPSEEK_API_KEY)");
      }
      try {
        const { text, sources }: WebSearchResult = await searchFn({
          apiKey: searchApiKey,
          query: params.query,
          model: searchModel,
          maxUses: params.max_uses ?? searchMaxUses,
        });
        const parts: string[] = [];
        if (text.length > 0) parts.push(text);
        if (sources.length > 0) {
          parts.push(`来源：\n${sources.map((s) => `- ${s.title} — ${s.url}`).join("\n")}`);
        }
        return textResult(parts.join("\n\n"));
      } catch (err) {
        return textResult(`web_search failed: ${errMessage(err)}`);
      }
    },
  });

  const webFetchTool = defineTool({
    name: "web_fetch",
    label: "Fetch a web page",
    description:
      "Fetch a URL with a real JS-capable headless browser and return its readable content (default Markdown). " +
      "Use this to read a specific page you already have a URL for — e.g. one returned by web_search. " +
      "`format` selects the rendering: \"markdown\" (default), \"html\" (raw rendered DOM), \"text\" (plain semantic text), " +
      "or \"semantic\" (semantic tree). Some sites may be unreachable from our network.",
    promptSnippet: "web_fetch — fetch a URL with a headless browser and return readable content (default Markdown)",
    promptGuidelines: [...GUIDELINES, WEB_FETCH_GUIDELINE],
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to fetch and read." }),
      format: Type.Optional(
        Type.String({
          description: "Rendering format: \"markdown\" (default), \"html\", \"text\", or \"semantic\".",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const format = toFetchFormat(params.format);
        const { text } = await runFetchImpl({ url: params.url, format, strip: "ui" });
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          return textResult("web_fetch returned no content (the page may be empty, or the site blocked it).");
        }
        return textResult(trimmed);
      } catch (err) {
        return textResult(`web_fetch failed: ${errMessage(err)}`);
      }
    },
  });

  const listSpaces = defineTool({
    name: "anytype_list_spaces",
    label: "List Anytype spaces",
    description:
      "List every Anytype space this assistant has joined (id + name). Use a returned id/name as the `space` argument of anytype_list_objects / anytype_search / anytype_read_object to read from that space.",
    promptSnippet: "anytype_list_spaces — list all joined spaces (id + name)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const spaces = await api.listSpaces();
        if (spaces.length === 0) return textResult("No spaces.");
        return textResult(spaces.map((s) => `${s.name || "(unnamed)"} — ${s.id}`).join("\n"));
      } catch (err) {
        return textResult(`anytype_list_spaces failed: ${errMessage(err)}`);
      }
    },
  });

  const memories = defineTool({
    name: "anytype_memories",
    label: "Read memories",
    description:
      "Read the assistant's durable memories: the global MEMORY.md plus every per-space MEMORY.md, each labelled with its space name. Use this to recall what has been recorded anywhere.",
    promptSnippet: "anytype_memories — read global + per-space memories",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const root = consoleDep!.workspaceRoot;
        const items = collectMemories(root);
        if (items.length === 0) return textResult("(no memories recorded yet)");
        const names = new Map((await api.listSpaces()).map((s) => [s.id, s.name]));
        const blocks = items.map((m) => {
          const label = m.spaceId === "_global" ? "全局 (global)" : `${names.get(m.spaceId) || m.spaceId}`;
          return `## ${label} [${m.spaceId}]\n${m.text.trim()}`;
        });
        return textResult(blocks.join("\n\n"));
      } catch (err) {
        return textResult(`anytype_memories failed: ${errMessage(err)}`);
      }
    },
  });

  const joinSpace = defineTool({
    name: "anytype_join_space",
    label: "Join a space",
    description:
      "Join a space from a link the user shared. An INVITE link adds the assistant to that shared space; a 1:1 (hi.any.coop) link connects the assistant to the user's one-to-one console. Only call this when the user clearly asks to join / connect using a link they provided.",
    promptSnippet: "anytype_join_space — join a space or connect the 1:1 console from a link",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      link: Type.String({ description: "The invite or 1:1 link to act on." }),
    }),
    async execute(_id, params) {
      if (!consoleDep?.joinSpace) return textResult("anytype_join_space unavailable in this session.");
      try {
        const r = await consoleDep.joinSpace(params.link);
        return textResult(r.message);
      } catch (err) {
        return textResult(`anytype_join_space failed: ${errMessage(err)}`);
      }
    },
  });

  const tools = [
    listObjects,
    search,
    readObject,
    downloadImages,
    downloadFile,
    cropImage,
    createNote,
    updateObject,
    editObject,
    updateBlock,
    deleteBlock,
    deleteObject,
    setProperty,
    listProperties,
    createProperty,
    listTypes,
    createType,
    updateType,
    deleteType,
    createCollection,
    collectionItems,
    uploadFile,
    watch,
    sendMessage,
    react,
    editMessage,
    deleteMessage,
    templates,
    insertMarkdown,
    webSearchTool,
    webFetchTool,
  ] as ToolDefinition[];

  // Cross-space read tools and the memory aggregate are only for the global
  // console session.
  if (consoleDep) tools.push(listSpaces, memories, joinSpace);

  // Only the parent agent gets the subagent tool; child sessions omit it, so
  // they cannot spawn further sub-agents (no recursion).
  if (runSubagent) {
    tools.push(
      defineTool({
        name: "subagent",
        label: "Delegate to a sub-agent",
        description:
          "Spawn a fresh, isolated sub-agent with the SAME Anytype tools to run an independent sub-task, and return its final answer. " +
          "Use it to keep this conversation's context focused: for example summarize several pages, or search + read many objects, " +
          "and get back just the result instead of every intermediate step. " +
          "The sub-agent does NOT see this conversation, so `task` must be a complete, self-contained instruction. " +
          "It cannot spawn further sub-agents. Each call is a full extra model run and costs tokens, so reserve it for genuinely " +
          "independent, parallelizable work rather than trivial steps.",
        promptSnippet: "subagent — delegate an independent sub-task to a fresh sub-agent",
        promptGuidelines: GUIDELINES,
        parameters: Type.Object({
          task: Type.String({
            description:
              "A complete, self-contained instruction for the sub-agent (it does NOT see this conversation).",
          }),
        }),
        async execute(_toolCallId, params) {
          try {
            const r = await runSubagent(params.task);
            return textResult(r.trim() ? r.trim() : "(sub-agent returned no text)");
          } catch (err) {
            return textResult("subagent failed: " + errMessage(err));
          }
        },
      }),
    );
  }

  // Persistent, named sub-agents. Only the parent agent gets this tool; child
  // sessions omit it (no agentRegistry), so they cannot spawn further agents.
  if (agentRegistry) {
    tools.push(
      defineTool({
        name: "agent",
        label: "Named persistent sub-agents",
        description:
          "Manage DURABLE, NAMED sub-agents you can talk to across multiple turns. " +
          "`spawn` creates (or returns) a named agent once; then `message` the SAME agent repeatedly — " +
          "it keeps its own conversation and memory between messages, so you can build up context over " +
          "several turns instead of re-explaining everything each time. " +
          "A sub-agent does NOT see THIS chat's conversation, so every `task`/`message` must be a " +
          "complete, self-contained instruction. " +
          "Sub-agents cannot spawn further agents. Each spawn/message is a full extra model run and " +
          "costs tokens, so reuse a named agent rather than spawning many. " +
          "Actions: `spawn` (needs `name`; optional `task` runs a first message), " +
          "`message` (needs `name` + `message`), `list`, `kill` (needs `name`).",
        promptSnippet: "agent — durable named sub-agents: spawn once, then message repeatedly",
        promptGuidelines: GUIDELINES,
        parameters: Type.Object({
          action: Type.Union(
            [
              Type.Literal("spawn"),
              Type.Literal("message"),
              Type.Literal("list"),
              Type.Literal("kill"),
            ],
            { description: "spawn | message | list | kill" },
          ),
          name: Type.Optional(
            Type.String({ description: "Sub-agent name (required for spawn/message/kill)." }),
          ),
          task: Type.Optional(
            Type.String({ description: "For spawn: an optional first, self-contained task to run immediately." }),
          ),
          message: Type.Optional(
            Type.String({ description: "For message: the self-contained message to send to the named agent." }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            switch (params.action) {
              case "spawn": {
                if (!params.name) return textResult("agent failed: `name` is required for spawn");
                await agentRegistry.spawn(params.name);
                if (params.task) return textResult(await agentRegistry.message(params.name, params.task));
                return textResult(`已创建子代理「${params.name}」`);
              }
              case "message": {
                if (!params.name) return textResult("agent failed: `name` is required for message");
                if (!params.message) return textResult("agent failed: `message` is required for message");
                return textResult(await agentRegistry.message(params.name, params.message));
              }
              case "list": {
                const items = agentRegistry.list();
                if (items.length === 0) return textResult("(no sub-agents)");
                return textResult(
                  items
                    .map((a) => `- ${a.name} (${a.busy ? "busy" : "idle"}) — last: ${(a.lastResult ?? "").slice(0, 60)}`)
                    .join("\n"),
                );
              }
              case "kill": {
                if (!params.name) return textResult("agent failed: `name` is required for kill");
                const existed = agentRegistry.kill(params.name);
                return textResult(
                  existed ? `已删除子代理「${params.name}」` : `没有名为「${params.name}」的子代理`,
                );
              }
              default:
                return textResult("agent failed: unknown action");
            }
          } catch (err) {
            return textResult("agent failed: " + errMessage(err));
          }
        },
      }),
    );
  }

  return tools;
}
