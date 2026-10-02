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

/** A message poster (the Router's sink). */
export type MessageSender = (target: ChatTarget, text: string) => Promise<void> | void;

/** Split a reply into chat messages: one per non-blank line. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Send `text` as one message per (non-blank) line. */
export async function sendLines(send: MessageSender, target: ChatTarget, text: string): Promise<void> {
  for (const line of splitLines(text)) await send(target, line);
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
  /** Poster for the final answer (used by `finish`). */
  send?: MessageSender;
}

interface Bubble {
  id?: string;
  text: string;
  posted: boolean;
}

/**
 * Drives the turn's live chat output as a sequence of "bubbles":
 *
 *  - One bubble carries the current phase; it starts as a 🧠/⏳ status line and,
 *    when the model emits prose (narration), is edited IN PLACE to that prose.
 *  - When a TOOL follows such prose, a NEW bubble is opened (so the prose stays
 *    visible); a tool that does NOT follow prose just overwrites the status line.
 *  - `finish(reply)` removes EVERY transient bubble, then sends the answer split
 *    into one message per line. `stop()` removes them with no answer.
 *
 * The first bubble is posted after `delayMs` (fast turns never flash a bubble).
 * All failures are swallowed (logged) so status never breaks the turn.
 */
export class StatusReporter {
  private target?: ChatTarget;
  private bubbles: Bubble[] = [];
  private active?: Bubble;
  private activeIsNarration = false;
  private started = false;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private editTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private disabled = false;
  private posting?: Promise<void>;
  private editing?: Promise<void>;

  constructor(private readonly opts: StatusReporterOptions) {}

  private warn(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(m)))(msg);
  }

  start(target: ChatTarget): void {
    if (this.disabled || this.stopped) return;
    this.target = target;
    const delay = this.opts.delayMs ?? 1500;
    this.delayTimer = setTimeout(() => {
      this.delayTimer = undefined;
      this.started = true;
      // A slow turn may reach the delay with no progress yet (e.g. the model is
      // still thinking): open the first bubble so the placeholder still posts.
      if (!this.active) {
        this.active = { text: STATUS_THINKING, posted: false };
        this.bubbles.push(this.active);
      }
      this.flushPost();
    }, delay);
  }

  /** Called as the turn's phase changes. */
  onProgress(p: AgentProgress): void {
    if (this.disabled || this.stopped || !this.target) return;
    if (p.kind === "narration") {
      this.setActiveText(p.text, true);
    } else if (p.kind === "tool") {
      if (this.activeIsNarration) this.active = undefined; // open a new bubble
      this.setActiveText(formatToolProgress(p.tool, p.args), false);
    } else {
      if (this.activeIsNarration) this.active = undefined;
      this.setActiveText(STATUS_THINKING, false);
    }
  }

  private setActiveText(text: string, narration: boolean): void {
    if (!this.active) {
      this.active = { text, posted: false };
      this.bubbles.push(this.active);
      if (this.started) this.flushPost();
    } else {
      this.active.text = text;
    }
    this.activeIsNarration = narration;
    if (this.active.posted) this.scheduleEdit();
  }

  private flushPost(): void {
    const b = this.active;
    if (!b || b.posted || this.disabled || this.stopped || !this.target) return;
    const isFirst = this.bubbles[0] === b;
    const text = isFirst ? STATUS_PLACEHOLDER : b.text;
    const p = this.doPost(b, text).finally(() => {
      if (this.posting === p) this.posting = undefined;
    });
    this.posting = p;
  }

  private async doPost(b: Bubble, text: string): Promise<void> {
    if (!this.target) return;
    try {
      const id = await this.opts.status.post(this.target, text);
      if (this.stopped) {
        await this.safeRemove(id);
        return;
      }
      b.id = id;
      b.posted = true;
      if (b.text !== text) this.scheduleEdit(); // reconcile to the latest text
    } catch (err) {
      this.disabled = true;
      this.warn(`status post failed: ${String(err)}`);
    }
  }

  private scheduleEdit(): void {
    if (this.disabled || this.stopped) return;
    if (this.editTimer) return;
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
    const b = this.active;
    if (this.disabled || this.stopped || !b || !b.posted || b.id === undefined || !this.target) {
      return;
    }
    try {
      await this.opts.status.edit(this.target, b.id, b.text);
    } catch (err) {
      this.warn(`status edit failed: ${String(err)}`);
    }
  }

  /** End the turn: drop all transient bubbles, then post the answer (one line per message). */
  async finish(reply: string): Promise<void> {
    await this.teardown();
    if (this.opts.send && this.target) await sendLines(this.opts.send, this.target, reply);
  }

  /** End the turn with no answer (error/interrupt): just drop the transient bubbles. */
  async stop(): Promise<void> {
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    this.stopped = true;
    if (this.delayTimer) {
      clearTimeout(this.delayTimer);
      this.delayTimer = undefined;
    }
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
    await this.posting?.catch(() => undefined);
    await this.editing?.catch(() => undefined);
    for (const b of this.bubbles) {
      if (b.posted && b.id !== undefined) await this.safeRemove(b.id);
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
