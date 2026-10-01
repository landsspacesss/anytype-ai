export interface ManagedClient {
  readonly busy: boolean;
  prompt(message: string): Promise<string>;
  close(): Promise<void>;
  abort(): Promise<void>;
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
}

export class SessionManager {
  private entries = new Map<string, Entry>();
  private creating = 0;
  private waiters: Array<() => void> = [];
  private now: () => number;

  constructor(private opts: SessionManagerOptions) {
    this.now = opts.now ?? Date.now;
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

  async run(chatId: string, prompt: string): Promise<string> {
    let entry = this.entries.get(chatId);
    if (!entry) {
      await this.acquireSlot();
      let client: ManagedClient;
      try {
        client = await this.opts.createClient(chatId);
      } catch (err) {
        this.creating--;
        this.releaseSlot();
        throw err;
      }
      entry = { client, queue: Promise.resolve(), lastUsed: this.now(), pending: 0 };
      this.entries.set(chatId, entry);
      this.creating--;
    }
    const e = entry;
    e.pending++;
    const result = e.queue.then(async () => {
      e.lastUsed = this.now();
      return e.client.prompt(prompt);
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
      if (e.client.busy) continue;
      if (e.lastUsed < cutoff) {
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
