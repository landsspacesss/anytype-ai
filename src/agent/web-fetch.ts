/**
 * Fetch a URL's rendered content with Lightpanda — the official headless
 * browser binary (https://github.com/lightpanda-io/browser), baked into the
 * runtime image at /usr/local/bin/lightpanda.
 *
 * Unlike a plain HTTP GET, Lightpanda executes JavaScript, so we see the DOM a
 * real browser would build. Output is one of its dump formats; we default to
 * Markdown for readable, token-friendly text.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type WebFetchFormat = "markdown" | "html" | "semantic_tree" | "semantic_tree_text";

export interface WebFetchOptions {
  url: string;
  /** Dump format (default "markdown"). */
  format?: WebFetchFormat;
  /** Comma list of noise to strip, e.g. "ui" (default "ui" — drops images/css). */
  strip?: string;
  /** Max characters returned; longer output is cut (default 20000). */
  maxChars?: number;
  /** Kill the browser after this many ms (default 30000). */
  timeoutMs?: number;
  /** Binary to run (default "lightpanda"). */
  bin?: string;
  /** Injectable exec for tests (default: the real promisified execFile). */
  _exec?: WebFetchExec;
}

export interface WebFetchResult {
  text: string;
  truncated: boolean;
}

/** The subset of child_process.execFile we depend on (injectable for tests). */
export type WebFetchExec = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

/** execFile with a string-typed promise result (Node's default utf8 encoding). */
const execFileAsync = promisify(execFile) as unknown as WebFetchExec;

/** Big enough for a large JS-heavy page's DOM (the lightpanda default is tiny). */
const MAX_BUFFER = 32 * 1024 * 1024;

/** How much stderr tail to surface in an error message. */
const STDERR_TAIL = 300;

/**
 * Build the Lightpanda argv for a fetch: `fetch --dump <format> --strip-mode
 * <strip> <url>`. Pure, so tests can assert the exact command without a binary.
 */
export function buildFetchArgs(opts: { url: string; format?: string; strip?: string }): string[] {
  const format = opts.format ?? "markdown";
  const strip = opts.strip ?? "ui";
  return ["fetch", "--dump", format, "--strip-mode", strip, opts.url];
}

/** Last N chars of stderr (trimmed), for a concise error message. */
function tail(s: string, n: number = STDERR_TAIL): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Turn an execFile failure into a concise message, preferring the stderr tail. */
function execErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim().length > 0) return tail(e.stderr);
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
  }
  return String(err);
}

/**
 * Run Lightpanda against `url` and return its rendered dump as text.
 *
 * `text` is stdout trimmed and cut to `maxChars`; `truncated` is true when it
 * was cut. Throws an Error (with the stderr tail) on a non-zero exit or spawn
 * failure.
 */
export async function webFetch(opts: WebFetchOptions): Promise<WebFetchResult> {
  const {
    url,
    format = "markdown",
    strip = "ui",
    maxChars = 20000,
    timeoutMs = 30000,
    bin = "lightpanda",
    _exec = execFileAsync,
  } = opts;

  const args = buildFetchArgs({ url, format, strip });

  let stdout: string;
  try {
    const res = await _exec(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    stdout = res.stdout;
  } catch (err) {
    throw new Error(`lightpanda fetch failed: ${execErrorMessage(err)}`);
  }

  const trimmed = stdout.trim();
  const truncated = trimmed.length > maxChars;
  const text = truncated ? trimmed.slice(0, maxChars) : trimmed;
  return { text, truncated };
}
