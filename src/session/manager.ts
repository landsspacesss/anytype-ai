/**
 * A progress notification during an agent turn: either the model is thinking
 * (reasoning between tool calls) or a tool is executing. `args` is the raw
 * tool-call arguments as delivered by pi (shape varies per tool).
 */
export type AgentProgress =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; args?: unknown };

/** Callback invoked as the turn's phase changes (thinking ↔ a tool call). */
export type ProgressCallback = (p: AgentProgress) => void;

export interface ManagedClient {
  readonly busy: boolean;
  prompt(message: string, onProgress?: ProgressCallback): Promise<string>;
  close(): Promise<void>;
  abort(): Promise<void>;
  /** Start a fresh conversation for this chat (next client will not resume old history). */
  reset?(): Promise<void>;
  /** Compact/condense the conversation. Returns a short status line. */
  compact?(): Promise<string>;
  /** Switch model by id; returns the resolved model id, or null if unknown. */
  setModel?(id: string): Promise<string | null>;
  /** Current model id (or a placeholder when unset). */
  getModel?(): string;
  /** Set the thinking level; returns the level actually applied. */
  setThinkingLevel?(level: string): string;
  /** Current thinking level. */
  getThinkingLevel?(): string;
  /** Toggle YOLO / auto-approve (all tools) mode; returns a short status. */
  setAutoTools?(enabled: boolean): string;
  /** Whether YOLO / auto-approve mode is on. */
  isAutoTools?(): boolean;
}

interface Entry {
  client: ManagedClient;
  queue: Promise<unknown>;
  lastUsed: number;
  pending: number;
}

export interface SessionManagerOptions {
  createClient: (chatId: string) => Promise<ManagedClient>;
  maxConcurrent: number;
  idleMs: number;
  now?: () => number;
  /**
   * Called by `reset(chatId)` to drop any persisted history for that chat
   * (e.g. delete the chat's session JSONL). Optional: without it, `reset` still
   * forgets the in-memory client and starts the next conversation fresh.
   */
  clearHistory?: (chatId: string) => void | Promise<void>;
}

export class SessionManager {
  private entries = new Map<string, Entry>();
  private creating = 0;
  private waiters: Array<() => void> = [];
  private now: () => number;
  // Chats whose NEXT client must start from a clean slate (set by reset()).
  private freshChats = new Set<string>();

  constructor(private opts: SessionManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether the next client for this chat should resume persisted history.
   * False immediately after reset(chatId); the flag is consumed once a client
   * is (re)created, so subsequent restarts resume normally again.
   */
  resumeFor(chatId: string): boolean {
    return !this.freshChats.has(chatId);
  }

  private get liveCount(): number { return this.entries.size + this.creating; }

  // Reserve the slot synchronously, before any await. If we only counted the
  // slot after `createClient` resolved, concurrent callers would all observe
  // `liveCount < maxConcurrent` and overshoot the cap.
  private async acquireSlot(): Promise<void> {
    if (this.liveCount < this.opts.maxConcurrent) {
      this.creating++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.acquireSlot();
  }

  private releaseSlot(): void {
    const w = this.waiters.shift();
    if (w) w();
  }

  /**
   * Return the existing entry for a chat, or create one (respecting the
   * concurrency cap). Shared by run() and ensure(). The `freshChats` flag is
   * consumed here (after createClient has read `resumeFor`) so the following
   * client resumes history normally again.
   */
  private async getOrCreate(chatId: string): Promise<Entry> {
    const found = this.entries.get(chatId);
    if (found) return found;
    await this.acquireSlot();
    let client: ManagedClient;
    try {
      client = await this.opts.createClient(chatId);
    } catch (err) {
      this.creating--;
      this.releaseSlot();
      throw err;
    }
    this.freshChats.delete(chatId);
    const existing = this.entries.get(chatId);
    if (existing) {
      // Lost a race: another caller created the entry while we awaited.
      this.creating--;
      await client.close().catch(() => undefined);
      this.releaseSlot();
      return existing;
    }
    const entry: Entry = { client, queue: Promise.resolve(), lastUsed: this.now(), pending: 0 };
    this.entries.set(chatId, entry);
    this.creating--;
    return entry;
  }

  /** Get the live client for a chat, or undefined if none exists yet. */
  get(chatId: string): ManagedClient | undefined {
    return this.entries.get(chatId)?.client;
  }

  /**
   * Get the live client for a chat, creating one if needed. Used by commands
   * that must read/modify per-chat agent settings (model, effort, tools, …).
   */
  async ensure(chatId: string): Promise<ManagedClient> {
    const entry = await this.getOrCreate(chatId);
    entry.lastUsed = this.now();
    return entry.client;
  }

  /**
   * Forget the chat's client so the next run builds a fresh session, and mark
   * the chat to NOT resume persisted history on that next build. Also invokes
   * the configured `clearHistory` hook to drop on-disk session files.
   */
  async reset(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (e) {
      this.entries.delete(chatId);
      await e.client.close().catch(() => undefined);
      this.releaseSlot();
    }
    this.freshChats.add(chatId);
    await this.opts.clearHistory?.(chatId);
  }

  async run(chatId: string, prompt: string, onProgress?: ProgressCallback): Promise<string> {
    const e = await this.getOrCreate(chatId);
    e.pending++;
    const result = e.queue.then(async () => {
      e.lastUsed = this.now();
      return e.client.prompt(prompt, onProgress);
    });
    e.queue = result.catch(() => undefined);
    const done = (): void => { e.pending--; this.evictIfContended(chatId, e); };
    result.then(done, done);
    return result;
  }

  // When callers are waiting for a slot, a finished client yields its slot so
  // the next chat can run. With nobody waiting the client stays warm for reuse.
  private async evictIfContended(chatId: string, e: Entry): Promise<void> {
    if (e.pending > 0) return;                 // still work queued for this chat — keep the client alive
    if (this.waiters.length === 0) return;
    if (this.entries.get(chatId) !== e) return;
    this.entries.delete(chatId);
    await e.client.close().catch(() => undefined);
    this.releaseSlot();
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.opts.idleMs;
    for (const [chatId, e] of [...this.entries]) {
      if (e.pending > 0) continue;
      if (e.client.busy) continue;
      if (e.lastUsed < cutoff) {
        if (this.entries.get(chatId) !== e) continue;
        this.entries.delete(chatId);
        await e.client.close().catch(() => undefined);
        this.releaseSlot();
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [, e] of [...this.entries]) {
      await e.client.close().catch(() => undefined);
    }
    this.entries.clear();
  }
}
