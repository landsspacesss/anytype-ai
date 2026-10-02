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

/**
 * How an in-flight turn reacts when a newer message arrives for the same chat.
 *
 * - `immediate` — stop the running turn right away, even mid tool call.
 * - `step` — stop at the next safe point: immediately while the model is
 *   thinking or running a read-only tool, but let an in-flight *write* tool
 *   finish first so we never leave a half-written object behind.
 */
export type InterruptPolicy = "immediate" | "step";

/** Default policy: the safe one (never cut a write short). */
export const DEFAULT_INTERRUPT_POLICY: InterruptPolicy = "step";

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
  /** Set how this chat's in-flight turn reacts to a newer message. */
  setInterruptPolicy?(policy: InterruptPolicy): void;
  /** Current interrupt policy. */
  getInterruptPolicy?(): InterruptPolicy;
  /** Apply the current policy to the running turn (no-op when idle). */
  requestInterrupt?(): Promise<void>;
}

/** One queued agent turn; `resolve` carries the reply ("" when superseded). */
interface Turn {
  prompt: string;
  onProgress?: ProgressCallback;
  /** Set when a newer message arrived: this turn is dropped / its reply muted. */
  superseded: boolean;
  resolve: (reply: string) => void;
  reject: (err: unknown) => void;
}

interface Entry {
  client: ManagedClient;
  lastUsed: number;
  /** Turns awaiting/undergoing execution, head first. */
  turns: Turn[];
  /** True while the pump loop is draining `turns`. */
  pumping: boolean;
}

export interface SessionManagerOptions {
  createClient: (chatId: string) => Promise<ManagedClient>;
  maxConcurrent: number;
  idleMs: number;
  now?: () => number;
  /** Policy applied to chats that never had one set. Default `step`. */
  defaultInterruptPolicy?: InterruptPolicy;
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
  // Per-chat interrupt policy, remembered across client rebuilds.
  private policies = new Map<string, InterruptPolicy>();

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

  /** The interrupt policy for a chat (falls back to the live client, then default). */
  getInterruptPolicy(chatId: string): InterruptPolicy {
    return (
      this.policies.get(chatId) ??
      this.entries.get(chatId)?.client.getInterruptPolicy?.() ??
      this.opts.defaultInterruptPolicy ??
      DEFAULT_INTERRUPT_POLICY
    );
  }

  /**
   * Set a chat's interrupt policy. Takes effect immediately: when a turn is
   * running, it is interrupted according to the new policy (so `/interrupt`
   * needs no restart and does not itself queue behind the running turn).
   */
  async setInterruptPolicy(chatId: string, policy: InterruptPolicy): Promise<InterruptPolicy> {
    this.policies.set(chatId, policy);
    const e = this.entries.get(chatId);
    if (e) {
      e.client.setInterruptPolicy?.(policy);
      await e.client.requestInterrupt?.().catch(() => undefined);
    }
    return policy;
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
    client.setInterruptPolicy?.(this.getInterruptPolicy(chatId));
    const existing = this.entries.get(chatId);
    if (existing) {
      // Lost a race: another caller created the entry while we awaited.
      this.creating--;
      await client.close().catch(() => undefined);
      this.releaseSlot();
      return existing;
    }
    const entry: Entry = { client, lastUsed: this.now(), turns: [], pumping: false };
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
      for (const t of e.turns.splice(0)) t.resolve("");
      await e.client.close().catch(() => undefined);
      this.releaseSlot();
    }
    this.freshChats.add(chatId);
    await this.opts.clearHistory?.(chatId);
  }

  /**
   * Run a turn for a chat. When a turn is already in flight, the newer message
   * WINS: everything pending for this chat is superseded and the running turn
   * is interrupted per its policy (see `InterruptPolicy`). Returns "" for a
   * turn that was superseded before/while it ran.
   */
  async run(chatId: string, prompt: string, onProgress?: ProgressCallback): Promise<string> {
    const e = await this.getOrCreate(chatId);
    if (e.turns.length > 0) {
      for (const t of e.turns) t.superseded = true;
      void e.client.requestInterrupt?.().catch(() => undefined);
    }
    let resolve!: (reply: string) => void;
    let reject!: (err: unknown) => void;
    const reply = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    e.turns.push({ prompt, onProgress, superseded: false, resolve, reject });
    void this.pump(chatId, e);
    return reply;
  }

  // Drain the chat's turn queue serially. Only one pump runs per entry; a new
  // turn pushed while pumping is picked up by the running loop. The turn being
  // executed stays at turns[0] until it settles, so `turns.length > 0` (and thus
  // run()'s interrupt check) also sees the in-flight turn.
  private async pump(chatId: string, e: Entry): Promise<void> {
    if (e.pumping) return;
    e.pumping = true;
    try {
      while (e.turns.length > 0) {
        const turn = e.turns[0];
        if (turn.superseded) {
          this.drop(e, turn);
          turn.resolve(""); // dropped before it ever reached the model
          continue;
        }
        e.lastUsed = this.now();
        let text: string;
        try {
          text = await e.client.prompt(turn.prompt, turn.onProgress);
        } catch (err) {
          this.drop(e, turn);
          turn.reject(err);
          continue;
        }
        // A turn interrupted mid-flight yields a partial reply — mute it.
        this.drop(e, turn);
        turn.resolve(turn.superseded ? "" : text);
      }
    } finally {
      e.pumping = false;
      await this.evictIfContended(chatId, e);
    }
  }

  /** Remove a settled turn (it may already be gone after reset/shutdown). */
  private drop(e: Entry, turn: Turn): void {
    const i = e.turns.indexOf(turn);
    if (i >= 0) e.turns.splice(i, 1);
  }

  // When callers are waiting for a slot, a finished client yields its slot so
  // the next chat can run. With nobody waiting the client stays warm for reuse.
  private async evictIfContended(chatId: string, e: Entry): Promise<void> {
    if (e.pumping || e.turns.length > 0) return; // still work for this chat — keep the client alive
    if (this.waiters.length === 0) return;
    if (this.entries.get(chatId) !== e) return;
    this.entries.delete(chatId);
    await e.client.close().catch(() => undefined);
    this.releaseSlot();
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.opts.idleMs;
    for (const [chatId, e] of [...this.entries]) {
      if (e.turns.length > 0) continue;
      if (e.pumping) continue;
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
      for (const t of e.turns.splice(0)) t.resolve("");
      await e.client.close().catch(() => undefined);
    }
    this.entries.clear();
  }
}
