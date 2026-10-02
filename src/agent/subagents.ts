/**
 * Persistent, named sub-agents.
 *
 * Where the one-shot `subagent` tool spawns a fresh session for a single task
 * and disposes it, this registry keeps named child agents alive so the parent
 * can `spawn` once and then `message` the same agent repeatedly across turns —
 * each child keeps its own conversation/memory.
 *
 * Reaping is LAZY (no timers): `spawn`/`message` first dispose any non-busy
 * agent whose `lastUsed` is older than `idleMs`.
 */

/** A live child agent session. `busy` is a getter reflecting streaming state. */
export interface ChildAgent {
  readonly busy: boolean;
  prompt(text: string): Promise<string>;
  dispose(): void;
}

/** A snapshot of one registered sub-agent, for the `agent list` tool. */
export interface SubagentInfo {
  name: string;
  busy: boolean;
  lastUsed: number;
  lastResult?: string;
}

export interface SubagentRegistryOptions {
  /** Build a fresh child agent for a name. Called once per (re)spawn. */
  create: (name: string) => Promise<ChildAgent>;
  /** Live-agent cap; spawning beyond this throws. */
  maxAgents: number;
  /** Idle (non-busy) agents older than this are disposed on the next reap. */
  idleMs: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
}

interface Entry {
  agent: ChildAgent;
  lastUsed: number;
  lastResult?: string;
}

export class SubagentRegistry {
  private readonly agents = new Map<string, Entry>();

  constructor(private readonly opts: SubagentRegistryOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Dispose an agent, never throwing (dispose() must be best-effort). */
  private safeDispose(agent: ChildAgent): void {
    try {
      agent.dispose();
    } catch {
      /* ignore — a failing dispose must not break the registry */
    }
  }

  private info(name: string, e: Entry): SubagentInfo {
    return { name, busy: e.agent.busy, lastUsed: e.lastUsed, lastResult: e.lastResult };
  }

  /** Reap every non-busy agent idle for longer than `idleMs`. */
  private reap(): void {
    const cutoff = this.now() - this.opts.idleMs;
    for (const [name, e] of [...this.agents]) {
      if (!e.agent.busy && e.lastUsed < cutoff) {
        this.agents.delete(name);
        this.safeDispose(e.agent);
      }
    }
  }

  /** Create (or return an existing) named agent. Reaps idle ones first. */
  async spawn(name: string): Promise<SubagentInfo> {
    this.reap();
    const existing = this.agents.get(name);
    if (existing) return this.info(name, existing);
    if (this.agents.size >= this.opts.maxAgents) {
      throw new Error(`too many sub-agents (max ${this.opts.maxAgents})`);
    }
    const agent = await this.opts.create(name);
    const entry: Entry = { agent, lastUsed: this.now() };
    this.agents.set(name, entry);
    return this.info(name, entry);
  }

  /** Send a message to a named agent and return its reply. Reaps idle ones first. */
  async message(name: string, text: string): Promise<string> {
    this.reap();
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`no sub-agent named "${name}"`);
    const reply = await entry.agent.prompt(text);
    entry.lastUsed = this.now();
    entry.lastResult = reply;
    return reply;
  }

  /** Snapshot of every live agent (busy-first is not guaranteed; insertion order). */
  list(): SubagentInfo[] {
    return [...this.agents].map(([name, e]) => this.info(name, e));
  }

  /** Dispose + forget one agent. Returns false when the name is unknown. */
  kill(name: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    this.agents.delete(name);
    this.safeDispose(entry.agent);
    return true;
  }

  /** Dispose + forget every agent (used on session close). */
  killAll(): void {
    for (const name of [...this.agents.keys()]) this.kill(name);
  }
}
