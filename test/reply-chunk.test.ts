import { describe, it, expect } from "vitest";
import { chunkMessage } from "../src/reply/chunk.js";

describe("chunkMessage", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkMessage("hello", 100)).toEqual(["hello"]);
  });
  it("splits on newlines when possible", () => {
    const text = "a".repeat(60) + "\n" + "b".repeat(60);
    const out = chunkMessage(text, 100);
    expect(out.length).toBe(2);
    expect(out[0]).toBe("a".repeat(60));
    expect(out[1]).toBe("b".repeat(60));
  });
  it("hard-splits a long line with no newlines", () => {
    const out = chunkMessage("x".repeat(250), 100);
    expect(out.length).toBe(3);
    expect(out.every((c) => c.length <= 100)).toBe(true);
  });
  it("returns empty array for empty input", () => {
    expect(chunkMessage("", 100)).toEqual([]);
  });
});
