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
}
