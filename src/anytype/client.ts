import fs from "node:fs/promises";
import type { ChatRow, Member } from "../types.js";

export interface AnytypeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
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

  async sendMessage(spaceId: string, chatId: string, text: string, idempotencyKey: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers({ "Idempotency-Key": idempotencyKey }),
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  }

  async listSpaces(): Promise<Array<{ id: string; name: string }>> {
    const url = `${this.baseUrl}/v2/spaces`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listSpaces failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    return (body.data ?? []).map((s) => ({ id: s.id, name: s.name ?? "" }));
  }

  async listChats(spaceId: string): Promise<ChatRow[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listChats failed: ${res.status}`);
    const body = (await res.json()) as { data?: ChatRow[] };
    return body.data ?? [];
  }

  async listMembers(spaceId: string): Promise<Member[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/members`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listMembers failed: ${res.status}`);
    const body = (await res.json()) as { data?: Member[] };
    return body.data ?? [];
  }

  async getObject(spaceId: string, objectId: string): Promise<{ name?: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getObject failed: ${res.status}`);
    return (await res.json()) as { name?: string };
  }

  async listObjects(spaceId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects?limit=50`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listObjects failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string; type?: string }> };
    return (body.data ?? []).map((o) => ({ id: o.id ?? "", name: o.name ?? "", type: o.type ?? "" }));
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
    if (!res.ok) throw new Error(`filteredSearch failed: ${res.status}`);
    const parsed = (await res.json()) as { data?: Array<{ id?: string; name?: string; type?: string }> };
    return (parsed.data ?? []).map((o) => ({ id: o.id ?? "", name: o.name ?? "", type: o.type ?? "" }));
  }

  async getObjectRaw(spaceId: string, objectId: string): Promise<unknown> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getObjectRaw failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`downloadFileContent failed: ${res.status}`);
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
    const data = Buffer.from(await res.arrayBuffer());
    return { data, mimeType };
  }

  async createObject(
    spaceId: string,
    opts: { name: string; markdown?: string; type?: string },
  ): Promise<{ id: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: opts.type ?? "page",
        name: opts.name,
        markdown: opts.markdown ?? "",
      }),
    });
    if (!res.ok) throw new Error(`createObject failed: ${res.status}`);
    const body = (await res.json()) as { id?: string };
    return { id: body.id ?? "" };
  }

  /** Apply an atomic batch of ops (1..512) to an object: PATCH objects/{id}. */
  async patchObject(spaceId: string, objectId: string, ops: unknown[]): Promise<unknown> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ ops }),
    });
    if (!res.ok) throw new Error(`patchObject failed: ${res.status}`);
    return (await res.json()) as unknown;
  }

  /** Delete an object (page/note, collection, file, …): DELETE objects/{id}. */
  async deleteObject(spaceId: string, objectId: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new Error(`deleteObject failed: ${res.status}`);
  }

  /** List the space's properties (name/format and the key used to address them). */
  async listProperties(spaceId: string): Promise<Array<{ key: string; name: string; format: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/properties?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listProperties failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`createProperty failed: ${res.status}`);
    const parsed = (await res.json()) as { key?: string };
    return { key: parsed.key ?? "" };
  }

  /** List the space's object types (page, note, task, …). */
  async listTypes(spaceId: string): Promise<Array<{ key: string; name: string }>> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/types?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listTypes failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ key?: string; name?: string }> };
    return (body.data ?? []).map((t) => ({ key: t.key ?? "", name: t.name ?? "" }));
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
    if (!res.ok) throw new Error(`createCollection failed: ${res.status}`);
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
      if (!res.ok) throw new Error(`uploadFile failed: ${res.status}`);
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
      if (!res.ok) throw new Error(`uploadFile failed: ${res.status}`);
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? "" };
    }

    throw new Error("uploadFile failed: provide either url or path");
  }
}
