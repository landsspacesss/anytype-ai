import { describe, it, expect } from "vitest";
import { formatToolProgress, formatProgress, STATUS_THINKING } from "../src/reply/status.js";

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
