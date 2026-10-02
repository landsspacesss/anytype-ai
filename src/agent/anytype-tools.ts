import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnytypeClient } from "../anytype/client.js";

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

/**
 * Render an AnyBlock document for the model: the object title plus the text of
 * every block that carries a string `text` field. Robust to missing fields.
 */
function renderObject(doc: unknown): string {
  if (doc === null || typeof doc !== "object") return "Object has no readable content.";
  const d = doc as Record<string, unknown>;
  const props = (d.properties ?? {}) as Record<string, unknown>;
  const title = typeof props.name === "string" && props.name.length > 0 ? props.name : "(untitled)";

  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  const bodyText: string[] = [];
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (typeof block.text === "string" && block.text.length > 0) bodyText.push(block.text);
  }

  const lines = [`# ${title}`];
  if (bodyText.length > 0) {
    lines.push("", bodyText.join("\n"));
  } else {
    // No text — but don't call the page "empty": describe what IS there (e.g. images).
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
    lines.push("", `(no text content; ${blocks.length} block(s): ${summary})`);
  }
  return lines.join("\n");
}

/** Convert an unknown thrown value into a short message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const GUIDELINES = [
  "You are an AI assistant living INSIDE an Anytype space. The user's notes, pages, and objects live in Anytype — not on the local filesystem.",
  "For ANYTHING about the user's notes, pages, objects, or other content (including questions like \"how many notes are there?\" or \"find my note about X\"), ALWAYS use the `anytype_*` tools instead of listing/reading local workspace files.",
  "Never assume the words \"notes\" or \"笔记\" refer to local files — in this environment they mean Anytype objects in the current space.",
];

/**
 * Build the Anytype tool set bound to one space via the shared client.
 * Results are returned as text content; failures are surfaced to the model as
 * text (never thrown out of `execute`) so it can adapt.
 */
export function createAnytypeTools(deps: { api: AnytypeClient; spaceId: string }): ToolDefinition[] {
  const { api, spaceId } = deps;

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
      "Read a single Anytype object by id and return its title and text content. Use the id from anytype_list_objects or anytype_search.",
    promptSnippet: "anytype_read_object — read an Anytype object's title and content by id",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      id: Type.String({ description: "The object id to read." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const doc = await api.getObjectRaw(spaceId, params.id);
        return textResult(renderObject(doc));
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

  return [listObjects, search, readObject, createNote] as ToolDefinition[];
}
