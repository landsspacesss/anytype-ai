import { describe, it, expect, vi } from "vitest";
import { ReplySink } from "../src/reply/sink.js";

describe("ReplySink", () => {
  it("sends one message for short text", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "hello");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ spaceId: "s", chatId: "c" }, "hello", "k-0");
  });

  it("sends multiple messages for long text with distinct keys", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "x".repeat(250));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[2])).toEqual(["k-0", "k-1", "k-2"]);
  });

  it("sends nothing for empty text", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "");
    expect(send).not.toHaveBeenCalled();
  });
});
