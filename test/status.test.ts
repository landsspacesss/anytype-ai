import { describe, it, expect, vi } from "vitest";
import { formatToolProgress, formatProgress, STATUS_THINKING, StatusReporter, splitLines, sendLines } from "../src/reply/status.js";

describe("formatProgress", () => {
  it("renders the thinking phase", () => {
    expect(formatProgress({ kind: "thinking" })).toBe("🧠 思考中…");
    expect(STATUS_THINKING).toBe("🧠 思考中…");
  });

  it("renders a tool phase via formatToolProgress", () => {
    expect(formatProgress({ kind: "tool", tool: "anytype_search", args: { query: "物理" } })).toBe(
      '⏳ 正在 anytype_search("物理")…',
    );
    expect(formatProgress({ kind: "tool", tool: "anytype_list_objects" })).toBe(
      "⏳ 正在 anytype_list_objects…",
    );
  });
});

describe("formatToolProgress", () => {
  it("shows a query arg (JSON-quoted) for a search tool", () => {
    expect(formatToolProgress("anytype_search", { query: "物理" })).toBe(
      '⏳ 正在 anytype_search("物理")…',
    );
  });

  it("shows a name arg", () => {
    expect(formatToolProgress("anytype_create_note", { name: "weekly" })).toBe(
      '⏳ 正在 anytype_create_note("weekly")…',
    );
  });

  it("shows an id arg", () => {
    expect(formatToolProgress("anytype_read_object", { id: "abc123" })).toBe(
      '⏳ 正在 anytype_read_object("abc123")…',
    );
  });

  it("uses the first present key in priority order (query before id/name)", () => {
    expect(formatToolProgress("t", { id: "x", name: "n", query: "q" })).toBe('⏳ 正在 t("q")…');
    expect(formatToolProgress("t", { id: "x", name: "n" })).toBe('⏳ 正在 t("n")…');
  });

  it("renders a non-string hint as JSON", () => {
    expect(formatToolProgress("t", { key: 42 })).toBe("⏳ 正在 t(42)…");
  });

  it("falls back to JSON.stringify(args) when no known key is present", () => {
    expect(formatToolProgress("t", { foo: "bar" })).toBe('⏳ 正在 t({"foo":"bar"})…');
  });

  it("omits the parentheses for undefined / empty args", () => {
    expect(formatToolProgress("anytype_list_objects", undefined)).toBe(
      "⏳ 正在 anytype_list_objects…",
    );
    expect(formatToolProgress("anytype_list_objects", {})).toBe("⏳ 正在 anytype_list_objects…");
    expect(formatToolProgress("anytype_list_objects", null)).toBe("⏳ 正在 anytype_list_objects…");
  });

  it("truncates a long hint to ~80 chars and marks it with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = formatToolProgress("t", { query: long });
    // `⏳ 正在 t(` + hint + `)…` where hint is capped at 80 + the truncation "…".
    const hint = out.slice("⏳ 正在 t(".length, -2); // strip prefix and trailing ")…"
    expect(hint.length).toBeLessThanOrEqual(81);
    expect(hint.endsWith("…")).toBe(true);
    expect(out.endsWith(")…")).toBe(true);
  });

  it("never emits a newline", () => {
    const out = formatToolProgress("t", { text: "line1\nline2" });
    expect(out).not.toContain("\n");
  });
});

function fakeTransport() {
  let n = 0;
  return {
    post: vi.fn(async () => `m${++n}`),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

describe("splitLines / sendLines", () => {
  it("splits on newlines, trims, drops blanks", () => {
    expect(splitLines("a\n\n  b  \r\nc")).toEqual(["a", "b", "c"]);
  });
  it("sendLines sends one message per line", async () => {
    const send = vi.fn(async () => {});
    await sendLines(send, { spaceId: "s", chatId: "c" }, "one\ntwo");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "one");
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "two");
  });
});

describe("StatusReporter rotating bubbles", () => {
  const T = { spaceId: "s", chatId: "c" };

  it("narration replaces the thinking bubble in place (no new post)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "thinking" });
      await vi.advanceTimersByTimeAsync(0);            // placeholder posts
      r.onProgress({ kind: "narration", text: "让我查一下" });
      await vi.advanceTimersByTimeAsync(0);            // edit to narration
      expect(status.post).toHaveBeenCalledTimes(1);
      expect(status.edit).toHaveBeenLastCalledWith(expect.anything(), "m1", "让我查一下");
    } finally { vi.useRealTimers(); }
  });

  it("a tool AFTER narration opens a NEW bubble", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "narration", text: "先查" });
      await vi.advanceTimersByTimeAsync(0);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.post).toHaveBeenCalledTimes(2);   // second bubble
    } finally { vi.useRealTimers(); }
  });

  it("a tool WITHOUT preceding narration reuses the bubble (no new post)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.post).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("finish removes every transient bubble then sends the answer per line", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "narration", text: "先查" });
      await vi.advanceTimersByTimeAsync(0);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      await r.finish("答案一\n答案二");
      expect(status.remove).toHaveBeenCalledTimes(2); // both bubbles
      expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "答案一");
      expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "答案二");
    } finally { vi.useRealTimers(); }
  });

  it("empty answer sends nothing (turn ended right after a tool)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "tool", tool: "x", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      await r.finish("");
      expect(send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("narration edit is not dropped when a tool rotates the bubble in the edit window", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 800 });
      r.start(T);
      await vi.advanceTimersByTimeAsync(0);                 // b0 posts (placeholder)
      r.onProgress({ kind: "narration", text: "先查一下" });
      await vi.advanceTimersByTimeAsync(100);               // within the edit window
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} }); // rotates → b1
      await vi.advanceTimersByTimeAsync(800);               // edit window fires
      expect(status.edit).toHaveBeenCalledWith(expect.anything(), expect.any(String), "先查一下");
    } finally { vi.useRealTimers(); }
  });
});
