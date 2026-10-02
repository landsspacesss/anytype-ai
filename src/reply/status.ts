import type { ChatTarget } from "../types.js";
import type { AgentProgress } from "../session/manager.js";

/** Text shown while the model is reasoning (default/placeholder state). */
export const STATUS_THINKING = "🧠 思考中…";

/** Text shown before any progress lands (same as the thinking state). */
export const STATUS_PLACEHOLDER = STATUS_THINKING;

/** Args keys we surface (in priority order) as a short hint next to the tool. */
const HINT_KEYS = ["query", "name", "id", "object_id", "text", "url", "task", "path", "key"];

/** Max characters of the argument hint before ellipsis. */
const HINT_MAX = 80;

/**
 * Format a tool-call progress line: `⏳ 正在 <tool>(<hint>)…`.
 *
 * The hint is the first present of the well-known arg keys, JSON-stringified
 * (so a string shows as `"物理"`), else the whole args JSON-stringified. The
 * hint is truncated to ~80 chars and newlines are stripped. With no usable
 * args we omit the parentheses entirely: `⏳ 正在 <tool>…`.
 */
export function formatToolProgress(tool: string, args: unknown): string {
  const hint = hintFor(args);
  return hint ? `⏳ 正在 ${tool}(${hint})…` : `⏳ 正在 ${tool}…`;
}

/**
 * Format one progress notification: thinking → 🧠, a tool call → ⏳, and a
 * transient narration → the prose itself (the model's pre-tool sentence).
 */
export function formatProgress(p: AgentProgress): string {
  if (p.kind === "thinking") return STATUS_THINKING;
  if (p.kind === "narration") return p.text;
  return formatToolProgress(p.tool, p.args);
}

/** Extract (and normalize) a short argument hint, or "" when there is none. */
function hintFor(args: unknown): string {
  if (args === undefined || args === null) return "";

  let raw: string | undefined;
  if (typeof args === "object" && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    let chosen: unknown;
    let found = false;
    for (const k of HINT_KEYS) {
      if (obj[k] !== undefined && obj[k] !== null) {
        chosen = obj[k];
        found = true;
        break;
      }
    }
    if (found) {
      raw = JSON.stringify(chosen);
    } else {
      if (Object.keys(obj).length === 0) return "";
      raw = JSON.stringify(obj);
    }
  } else {
    raw = JSON.stringify(args);
  }

  if (raw === undefined) return "";
  // Strip newlines (and collapse the whitespace around them) so the status line
  // stays a single line in the chat.
  let s = raw.replace(/\s*\r?\n\s*/g, " ").trim();
  if (s.length > HINT_MAX) s = s.slice(0, HINT_MAX) + "…";
  return s;
}

/** Transport the reporter uses to place/update/retract the status message. */
export interface StatusTransport {
  post(target: ChatTarget, text: string): Promise<string>;
  edit(target: ChatTarget, id: string, text: string): Promise<void>;
  remove(target: ChatTarget, id: string): Promise<void>;
}

export interface StatusReporterOptions {
  status: StatusTransport;
  /** Delay (ms) before the placeholder is posted. Default 1500. */
  delayMs?: number;
  /** Minimum spacing (ms) between edits. Default 800. */
  editIntervalMs?: number;
  /** Sink for non-fatal warnings. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/**
 * Drives a single self-updating "status" chat message for one agent turn:
 *
 *  - `start()` schedules the placeholder post after `delayMs` (fast turns that
 *    finish sooner never flash a placeholder).
 *  - `onProgress()` records the latest tool call; edits are coalesced to at
 *    most one per `editIntervalMs`, always reflecting the latest progress.
 *  - `stop()` retracts the placeholder (if posted) and cancels pending work.
 *
 * All failures are swallowed (logged) so a broken status never breaks the turn.
 */
export class StatusReporter {
  private delayTimer?: ReturnType<typeof setTimeout>;
  private editTimer?: ReturnType<typeof setTimeout>;
  private target?: ChatTarget;
  private messageId?: string;
  private posted = false;
  private stopped = false;
  private disabled = false;
  private pendingText?: string;
  private posting?: Promise<void>;
  private editing?: Promise<void>;

  constructor(private readonly opts: StatusReporterOptions) {}

  private warn(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(m)))(msg);
  }

  /** Begin the turn. Schedules the (delayed) placeholder post. */
  start(target: ChatTarget): void {
    if (this.disabled || this.stopped) return;
    this.target = target;
    const delay = this.opts.delayMs ?? 1500;
    this.delayTimer = setTimeout(() => {
      this.delayTimer = undefined;
      const p = this.post().finally(() => {
        if (this.posting === p) this.posting = undefined;
      });
      this.posting = p;
    }, delay);
  }

  private async post(): Promise<void> {
    if (this.posted || this.disabled || this.stopped || !this.target) return;
    try {
      const id = await this.opts.status.post(this.target, STATUS_PLACEHOLDER);
      if (this.stopped) {
        // The turn ended while the POST was in flight: retract immediately.
        await this.safeRemove(id);
        return;
      }
      this.messageId = id;
      this.posted = true;
      // Flush any progress that arrived before the placeholder existed.
      if (this.pendingText !== undefined) this.scheduleEdit();
    } catch (err) {
      this.disabled = true;
      this.warn(`status post failed: ${String(err)}`);
    }
  }

  /** Called as the turn's phase changes (thinking ↔ a tool call). */
  onProgress(p: AgentProgress): void {
    if (this.disabled || this.stopped) return;
    this.pendingText = formatProgress(p);
    // Nothing to edit yet — `post()` flushes pendingText once it lands.
    if (!this.posted) return;
    this.scheduleEdit();
  }

  // Trailing coalescer: at most one edit per window; the single pending edit
  // always carries the most recent text.
  private scheduleEdit(): void {
    if (this.disabled || this.stopped) return;
    if (this.editTimer) return; // window already open
    const interval = this.opts.editIntervalMs ?? 800;
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      const p = this.flushEdit().finally(() => {
        if (this.editing === p) this.editing = undefined;
      });
      this.editing = p;
    }, interval);
  }

  private async flushEdit(): Promise<void> {
    if (this.disabled || this.stopped || !this.posted || this.messageId === undefined || !this.target) {
      return;
    }
    const text = this.pendingText;
    this.pendingText = undefined;
    if (text === undefined) return;
    try {
      await this.opts.status.edit(this.target, this.messageId, text);
    } catch (err) {
      this.warn(`status edit failed: ${String(err)}`);
    }
    // Progress arrived while editing: open a new window for the latest text.
    if (this.pendingText !== undefined && !this.stopped && !this.disabled) this.scheduleEdit();
  }

  /** End the turn: cancel timers, drain in-flight work, retract the message. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.delayTimer) {
      clearTimeout(this.delayTimer);
      this.delayTimer = undefined;
    }
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
    // Let any in-flight POST/EDIT settle so removal is the last mutation.
    await this.posting?.catch(() => undefined);
    await this.editing?.catch(() => undefined);
    if (this.posted && this.messageId !== undefined) {
      await this.safeRemove(this.messageId);
    }
  }

  private async safeRemove(id: string): Promise<void> {
    if (!this.target) return;
    try {
      await this.opts.status.remove(this.target, id);
    } catch (err) {
      this.warn(`status remove failed: ${String(err)}`);
    }
  }
}
