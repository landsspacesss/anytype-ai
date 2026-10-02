/**
 * The three approval modes for a chat:
 * - `auto`     — never ask; every tool runs.
 * - `ask`      — a non-safe tool call posts a prompt and blocks until the user
 *                replies /approve, /approve all, or /deny (timeout → deny).
 * - `readonly` — no write tools at all (the classic safe set); sub-agents are
 *                allowed but inherit read-only, so they cannot write either.
 */
export type ApprovalMode = "auto" | "ask" | "readonly";

export function isApprovalMode(v: string): v is ApprovalMode {
  return v === "auto" || v === "ask" || v === "readonly";
}

/**
 * Tools that never need approval: pure local reads and read-only Anytype/web
 * reads. Everything else (writes, bash, sub-agents, unknown tools) is treated
 * as unsafe by default.
 */
export const SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read", "ls", "grep", "find",
  "anytype_list_objects",
  "anytype_search",
  "anytype_read_object",
  "anytype_download_images",
  "anytype_download_file",
  "crop_image",
  "anytype_list_properties",
  "anytype_list_types",
  "anytype_templates",
  "web_search",
  "web_fetch",
]);

/**
 * Whether an `ask`-mode tool call needs the user's approval. Sub-agents are
 * NOT "approval" targets — they are refused outright in ask mode (see the
 * gate), so they return false here.
 */
export function needsApproval(tool: string): boolean {
  if (tool === "subagent" || tool === "agent") return false;
  return !SAFE_TOOLS.has(tool);
}

/** Default prompt line for a pending approval. */
export function describeApproval(tool: string, args: unknown): string {
  let hint = "";
  try {
    if (args !== undefined && args !== null) {
      hint = JSON.stringify(args).replace(/\s*\r?\n\s*/g, " ");
      if (hint.length > 80) hint = hint.slice(0, 80) + "…";
    }
  } catch {
    hint = "";
  }
  const call = hint ? `${tool}(${hint})` : tool;
  return `⚠️ 想执行 ${call}，回复 /approve、/approve all 或 /deny`;
}

type Decision = "approve" | "all" | "deny";

export interface ApprovalGateOptions {
  /** Milliseconds before a pending request is auto-DENIED. */
  timeoutMs: number;
  /** Post the approval prompt into the chat. */
  post: (text: string) => Promise<void> | void;
  /** Build the prompt text (defaults to `describeApproval`). */
  describe?: (tool: string, args: unknown) => string;
  /** Non-fatal warning sink. Defaults to console.warn. */
  log?: (m: string) => void;
}

/**
 * Single-chat approval state machine. `request()` is awaited by the tool-call
 * hook; `resolve()` is called from /approve|/approve all|/deny commands. Purely
 * synchronous state plus one promise — no timers leak past a settle.
 */
export class ApprovalGate {
  private pending?: { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> };
  private _approvedAll = false;
  private readonly describe: (tool: string, args: unknown) => string;

  constructor(private readonly opts: ApprovalGateOptions) {
    this.describe = opts.describe ?? describeApproval;
  }

  get approvedAll(): boolean {
    return this._approvedAll;
  }

  /** Whether anything is currently awaiting a decision. */
  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** Await the user's decision for one tool call. Resolves true to allow. */
  async request(tool: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
    if (this._approvedAll) return true;
    if (signal?.aborted) return false;

    const decision = await new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.settle("deny"), this.opts.timeoutMs);
      this.pending = { resolve, timer };
      signal?.addEventListener("abort", () => this.settle("deny"), { once: true });
      Promise.resolve(this.opts.post(this.describe(tool, args))).catch((err) => {
        (this.opts.log ?? ((m: string) => console.warn(m)))(`approval post failed: ${String(err)}`);
        this.settle("deny");
      });
    });
    if (decision === "all") this._approvedAll = true;
    return decision !== "deny";
  }

  /** Resolve a pending request from a command. Returns true if one was pending. */
  resolve(kind: Decision): boolean {
    if (kind === "all") this._approvedAll = true;
    if (!this.pending) return false;
    this.settle(kind);
    return true;
  }

  /** End-of-turn: forget "approve all" and deny anything still pending. */
  resetTurn(): void {
    this._approvedAll = false;
    if (this.pending) this.settle("deny");
  }

  private settle(d: Decision): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    p.resolve(d);
  }
}
