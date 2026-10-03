import fs from "node:fs/promises";
import type { ChatRow, Member } from "../types.js";

export interface AnytypeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

/** An API error carrying the HTTP status, so callers can tell 404 from a blip. */
export class AnytypeApiError extends Error {
  constructor(
    public readonly status: number,
    method: string,
  ) {
    super(`${method} failed: ${status}`);
    this.name = "AnytypeApiError";
  }
}

export class AnytypeClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(opts: AnytypeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...extra };
  }

  async sendMessage(
    spaceId: string,
    chatId: string,
    text: string,
    idempotencyKey: string,
    attachments?: string[],
  ): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages`;
    const body: Record<string, unknown> = { text };
    if (attachments && attachments.length > 0) body.attachments = attachments;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers({ "Idempotency-Key": idempotencyKey }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "sendMessage");
  }

  /**
   * Like `sendMessage`, but returns the created message's id so the caller can
   * later edit/delete it (used for the live tool-call status placeholder).
   */
  async sendMessageReturningId(
    spaceId: string,
    chatId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers({ "Idempotency-Key": idempotencyKey }),
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "sendMessageReturningId");
    const body = (await res.json()) as { id?: string };
    return body.id ?? "";
  }

  /**
   * Create a chat in the space. Returns its id. (Anytype exposes no chat delete
   * endpoint: a chat created here can only be archived in the app.)
   */
  async createChat(spaceId: string, name: string): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createChat");
    const body = (await res.json()) as { id?: string };
    return { id: body.id ?? "" };
  }

  /** Add an emoji reaction to a chat message. */
  async reactToMessage(spaceId: string, chatId: string, messageId: string, emoji: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages/${messageId}/reactions`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ emoji }),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "reactToMessage");
  }

  /** Edit a chat message's text in place. */
  async editMessage(spaceId: string, chatId: string, messageId: string, text: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages/${messageId}`;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "editMessage");
  }

  /** Delete a chat message. */
  async deleteMessage(spaceId: string, chatId: string, messageId: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages/${messageId}`;
    const res = await this.fetchFn(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "deleteMessage");
  }

  async listSpaces(): Promise<Array<{ id: string; name: string }>> {
    const url = `${this.baseUrl}/v2/spaces`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listSpaces");
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    return (body.data ?? []).map((s) => ({ id: s.id, name: s.name ?? "" }));
  }

  async listChats(spaceId: string): Promise<ChatRow[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listChats");
    const body = (await res.json()) as { data?: ChatRow[] };
    return body.data ?? [];
  }

  async listMembers(spaceId: string): Promise<Member[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/members`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listMembers");
    const body = (await res.json()) as { data?: Member[] };
    return body.data ?? [];
  }

  async getObject(spaceId: string, objectId: string): Promise<{ name?: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "getObject");
    return (await res.json()) as { name?: string };
  }

  async listObjects(spaceId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects?limit=50`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listObjects");
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string; type?: string }> };
    return (body.data ?? []).map((o) => ({ id: o.id ?? "", name: o.name ?? "", type: o.type ?? "" }));
  }

  /**
   * List every object of one type (e.g. "image", "file", "task"). The plain
   * object list hides loose files/images, but a type-filtered query enumerates
   * them. Creates a throwaway query, lists its objects, then deletes the query.
   */
  async listObjectsOfType(
    spaceId: string,
    type: string,
    limit = 100,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    const qurl = `${this.baseUrl}/v2/spaces/${spaceId}/queries`;
    const qres = await this.fetchFn(qurl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: `__list_${type}_${Date.now()}__`, type }),
    });
    if (!qres.ok) throw new AnytypeApiError(qres.status, "listObjectsOfType(query)");
    const qid = ((await qres.json()) as { id?: string }).id;
    if (!qid) return [];
    try {
      const ores = await this.fetchFn(
        `${this.baseUrl}/v2/spaces/${spaceId}/queries/${qid}/objects?limit=${limit}`,
        { headers: this.headers() },
      );
      if (!ores.ok) throw new AnytypeApiError(ores.status, "listObjectsOfType(objects)");
      const body = (await ores.json()) as { data?: Array<{ id?: string; name?: string; type?: string }> };
      return (body.data ?? []).map((o) => ({ id: o.id ?? "", name: o.name ?? "", type: o.type ?? "" }));
    } finally {
      // Best-effort cleanup of the throwaway query object.
      await this.fetchFn(`${this.baseUrl}/v2/spaces/${spaceId}/objects/${qid}`, {
        method: "DELETE",
        headers: this.headers(),
      }).catch(() => undefined);
    }
  }

  async search(
    spaceId: string,
    query: string,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    return this.filteredSearch(spaceId, { query });
  }

  /**
   * Search with optional structured filters. `filters` is a recursive
   * FilterNode tree (see the API docs); it is passed through verbatim as the
   * request body's `filters` field. Either `query` or `filters` may be given
   * (the other is omitted from the body).
   */
  async filteredSearch(
    spaceId: string,
    opts: { query?: string; filters?: unknown; limit?: number } = {},
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    const limit = opts.limit ?? 25;
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/search?limit=${limit}`;
    const body: Record<string, unknown> = {};
    if (opts.query !== undefined) body.query = opts.query;
    if (opts.filters !== undefined) body.filters = opts.filters;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "filteredSearch");
    const parsed = (await res.json()) as { data?: Array<{ id?: string; name?: string; type?: string }> };
    return (parsed.data ?? []).map((o) => ({ id: o.id ?? "", name: o.name ?? "", type: o.type ?? "" }));
  }

  async getObjectRaw(spaceId: string, objectId: string): Promise<unknown> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "getObjectRaw");
    return (await res.json()) as unknown;
  }

  /** Download a file's raw bytes (e.g. an image's `object_id` from a block). */
  async downloadFileContent(
    spaceId: string,
    fileId: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/files/${fileId}/content`;
    // NOTE: no Content-Type — this is a binary GET, not JSON.
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new AnytypeApiError(res.status, "downloadFileContent");
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
    const data = Buffer.from(await res.arrayBuffer());
    return { data, mimeType };
  }

  async createObject(
    spaceId: string,
    opts: { name: string; markdown?: string; type?: string; templateId?: string },
  ): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects`;
    const body: Record<string, unknown> = {
      type: opts.type ?? "page",
      name: opts.name,
      markdown: opts.markdown ?? "",
    };
    // When a template id is given, the new object starts from that template's
    // content (the server applies it before/alongside any markdown).
    if (opts.templateId) body.template = opts.templateId;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createObject");
    const parsed = (await res.json()) as { id?: string };
    return { id: parsed.id ?? "" };
  }

  /** Apply an atomic batch of ops (1..512) to an object: PATCH objects/{id}. */
  async patchObject(spaceId: string, objectId: string, ops: unknown[]): Promise<unknown> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ ops }),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "patchObject");
    return (await res.json()) as unknown;
  }

  /** Delete an object (page/note, collection, file, …): DELETE objects/{id}. */
  async deleteObject(spaceId: string, objectId: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "deleteObject");
  }

  /** List the space's properties (name/format and the key used to address them). */
  async listProperties(spaceId: string): Promise<Array<{ key: string; name: string; format: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/properties?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listProperties");
    const body = (await res.json()) as {
      data?: Array<{ key?: string; name?: string; format?: string }>;
    };
    return (body.data ?? []).map((p) => ({
      key: p.key ?? "",
      name: p.name ?? "",
      format: p.format ?? "",
    }));
  }

  /** Create a property (a "tag" is a select/multi_select property's options). */
  async createProperty(
    spaceId: string,
    opts: { name: string; format?: string; options?: Array<{ name: string; color?: string }> },
  ): Promise<{ key: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/properties`;
    const body: Record<string, unknown> = { name: opts.name, format: opts.format ?? "select" };
    if (opts.options && opts.options.length > 0) body.options = opts.options;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createProperty");
    const parsed = (await res.json()) as { key?: string };
    return { key: parsed.key ?? "" };
  }

  /** List the space's object types (page, note, task, …). */
  async listTypes(
    spaceId: string,
  ): Promise<Array<{ key: string; name: string; layout?: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/types?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listTypes");
    const body = (await res.json()) as {
      data?: Array<{ key?: string; name?: string; layout?: string }>;
    };
    return (body.data ?? []).map((t) => {
      const item: { key: string; name: string; layout?: string } = {
        key: t.key ?? "",
        name: t.name ?? "",
      };
      if (t.layout) item.layout = t.layout;
      return item;
    });
  }

  /**
   * Create an object type. `properties` is the type's whole field list (property
   * names; an unknown name mints a property). Returns the new type's key (the
   * API response's `body.key`).
   */
  async createType(
    spaceId: string,
    opts: {
      name: string;
      pluralName?: string;
      apiKey?: string;
      layout?: string;
      iconEmoji?: string;
      properties?: string[];
      defaultView?: string;
    },
  ): Promise<{ key: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/types`;
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.pluralName !== undefined) body.plural_name = opts.pluralName;
    if (opts.apiKey !== undefined) body.api_key = opts.apiKey;
    if (opts.layout !== undefined) body.layout = opts.layout;
    if (opts.iconEmoji !== undefined) body.icon = { format: "emoji", emoji: opts.iconEmoji };
    if (opts.properties !== undefined) {
      body.property_definitions = opts.properties.map((name) => ({ name }));
    }
    if (opts.defaultView !== undefined) body.default_view = opts.defaultView;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createType");
    const parsed = (await res.json()) as { key?: string };
    return { key: parsed.key ?? "" };
  }

  /** Update an object type: PATCH types/{key} with only the provided fields. */
  async updateType(
    spaceId: string,
    key: string,
    opts: {
      name?: string;
      pluralName?: string;
      layout?: string;
      iconEmoji?: string;
      defaultView?: string;
    },
  ): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/types/${key}`;
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.pluralName !== undefined) body.plural_name = opts.pluralName;
    if (opts.layout !== undefined) body.layout = opts.layout;
    if (opts.iconEmoji !== undefined) body.icon = { format: "emoji", emoji: opts.iconEmoji };
    if (opts.defaultView !== undefined) body.default_view = opts.defaultView;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "updateType");
  }

  /** Delete an object type: DELETE types/{key}. */
  async deleteType(spaceId: string, key: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/types/${key}`;
    const res = await this.fetchFn(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "deleteType");
  }

  /**
   * List the space's templates (optionally for one type key). Reads `body.data`
   * and maps the wire fields (`template_for`/`default`) to camelCase.
   */
  async listTemplates(
    spaceId: string,
    typeKey?: string,
  ): Promise<Array<{ id: string; name: string; templateFor: string; isDefault?: boolean }>> {
    const q = typeKey ? `?type=${encodeURIComponent(typeKey)}` : "";
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/templates${q}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "listTemplates");
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; template_for?: string; default?: boolean }>;
    };
    return (body.data ?? []).map((t) => ({
      id: t.id ?? "",
      name: t.name ?? "",
      templateFor: t.template_for ?? "",
      isDefault: t.default,
    }));
  }

  /**
   * Create a template for a type from an AnyBlock document. The templates
   * endpoint takes an AnyBlock doc (NOT the object endpoint's `markdown`
   * convenience field): `{formatVersion:"2.0", kind:"template",
   * template_for, properties:{name}, blocks}`. When only `markdown` is given we
   * convert it to blocks locally (see markdownToBlocks).
   */
  async createTemplate(
    spaceId: string,
    opts: { name: string; typeKey: string; markdown?: string; blocks?: unknown[]; icon?: string },
  ): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/templates`;
    const blocks = opts.blocks ?? markdownToBlocks(opts.markdown ?? "");
    const body: Record<string, unknown> = {
      formatVersion: "2.0",
      kind: "template",
      type: "template",
      template_for: opts.typeKey,
      properties: { name: opts.name },
      blocks,
    };
    if (opts.icon !== undefined) body.icon = opts.icon;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createTemplate");
    const parsed = (await res.json()) as { id?: string };
    return { id: parsed.id ?? "" };
  }

  /**
   * Delete a template. Note: the documented `DELETE /templates/{id}` route does
   * not exist (404); a template is an object, so it is deleted via the objects
   * route (verified live).
   */
  async deleteTemplate(spaceId: string, templateId: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${templateId}`;
    const res = await this.fetchFn(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new AnytypeApiError(res.status, "deleteTemplate");
  }

  /** Create a collection, optionally seeded with object ids. */
  async createCollection(
    spaceId: string,
    opts: { name: string; items?: string[] },
  ): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/collections`;
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.items && opts.items.length > 0) body.items = opts.items;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new AnytypeApiError(res.status, "createCollection");
    const parsed = (await res.json()) as { id?: string };
    return { id: parsed.id ?? "" };
  }

  /**
   * Upload a file into the space: by remote `url` (JSON) or from a local
   * `path` (multipart/form-data). Returns the new file object id.
   */
  async uploadFile(
    spaceId: string,
    opts: { url?: string; path?: string; name?: string },
  ): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/files`;

    if (opts.url) {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ url: opts.url, name: opts.name }),
      });
      if (!res.ok) throw new AnytypeApiError(res.status, "uploadFile");
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? "" };
    }

    if (opts.path) {
      const data = await fs.readFile(opts.path);
      const form = new FormData();
      const filename = opts.name ?? opts.path.split("/").pop() ?? "file";
      form.append("file", new Blob([data]), filename);
      // Do NOT set Content-Type: fetch adds the multipart boundary itself.
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new AnytypeApiError(res.status, "uploadFile");
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? "" };
    }

    throw new Error("uploadFile failed: provide either url or path");
  }
}

/** A random lowercase-hex id (used for generated table column/row ids). */
function hexId(len: number): string {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

/** Parse one markdown table row (`| a | b |`) into trimmed cells. */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** True for a markdown table's `| --- | --- |` separator row. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}

/**
 * Convert a markdown body into AnyBlock blocks for the templates endpoint
 * (which — unlike the objects endpoint — rejects a `markdown` field and needs
 * real blocks). Supports the common constructs: ATX headings, bulleted /
 * numbered / checkbox lists (with nesting via `indent`), blockquotes, fenced
 * code, dividers, GFM tables, and paragraphs. Inline formatting is left as-is
 * (AnyBlock accepts `**bold**`, `*italic*`, links, … inline).
 */
export function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const language = fence[1].trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      const b: Record<string, unknown> = { type: "code", text: code.join("\n") };
      if (language) b.language = language;
      blocks.push(b);
      continue;
    }

    // GFM table: a header row followed by a `| --- |` separator.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const dataRows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        dataRows.push(splitTableRow(lines[i]));
        i++;
      }
      const columns = header.map((h) => ({ id: hexId(24), header: h }));
      const rows = [
        { id: hexId(5), is_header: true, cells: header },
        ...dataRows.map((r) => ({ id: hexId(5), cells: r })),
      ];
      blocks.push({ type: "table", columns, rows });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // ATX heading (# .. ######); AnyBlock has heading_1..4.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      blocks.push({ type: `heading_${level}`, text: heading[2].trim() });
      i++;
      continue;
    }

    // Divider (checked before lists so `***`/`---` aren't list items).
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "divider" });
      i++;
      continue;
    }

    // Blockquote.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1] });
      i++;
      continue;
    }

    // Checkbox list item.
    const checkbox = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (checkbox) {
      const indent = Math.min(Math.floor(checkbox[1].length / 2), 32);
      const b: Record<string, unknown> = {
        type: "checkbox",
        checked: checkbox[2].toLowerCase() === "x",
        text: checkbox[3],
      };
      if (indent > 0) b.indent = indent;
      blocks.push(b);
      i++;
      continue;
    }

    // Bulleted list item.
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = Math.min(Math.floor(bullet[1].length / 2), 32);
      const b: Record<string, unknown> = { type: "bulleted_list_item", text: bullet[2] };
      if (indent > 0) b.indent = indent;
      blocks.push(b);
      i++;
      continue;
    }

    // Numbered list item.
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (numbered) {
      const indent = Math.min(Math.floor(numbered[1].length / 2), 32);
      const b: Record<string, unknown> = { type: "numbered_list_item", text: numbered[2] };
      if (indent > 0) b.indent = indent;
      blocks.push(b);
      i++;
      continue;
    }

    blocks.push({ type: "paragraph", text: line });
    i++;
  }
  return blocks;
}
