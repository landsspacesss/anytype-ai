import { describe, it, expect, vi } from "vitest";
import { handleEvent, subscribeChat } from "../src/anytype/stream.js";
import type { NormalizeCtx } from "../src/anytype/events.js";

const ctx: NormalizeCtx = {
  spaceId: "s1",
  chatId: "c1",
  botParticipantId: "_p_bot",
  isDirect: false,
};

describe("handleEvent", () => {
  it("passes ev.message (not the wrapper) into normalizeMessage and emits", () => {
    const onEvent = vi.fn();
    handleEvent(
      { id: "st1", type: "message_added", message: { id: "m1", author_id: "u1", text: "hi" } },
      ctx,
      onEvent,
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      spaceId: "s1",
      chatId: "c1",
      messageId: "m1",
      senderId: "u1",
      text: "hi",
    });
  });

  it("ignores non message_added event types", () => {
    const onEvent = vi.fn();
    handleEvent({ type: "state_updated", state: { unread: 0 } }, ctx, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed wrappers and null", () => {
    const onEvent = vi.fn();
    handleEvent({ type: "message_added" }, ctx, onEvent); // no message, normalize returns null
    handleEvent(null, ctx, onEvent);
    handleEvent("nope", ctx, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("subscribeChat", () => {
  it("dispatches message_added frames from the SSE body via injected fetch", async () => {
    const sse =
      'id: 1\nevent: message_added\ndata: {"id":"1","type":"message_added","message":{"id":"m1","author_id":"u1","text":"yo"}}\n\n' +
      ": keepalive\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const fetchFn = vi.fn(async () => ({ ok: true, body: stream })) as unknown as typeof fetch;
    const controller = new AbortController();
    const seen: string[] = [];
    await subscribeChat(
      {
        baseUrl: "http://x",
        apiKey: "k",
        spaceId: "s1",
        chatId: "c1",
        isDirect: false,
        botParticipantId: "_p_bot",
        onEvent: (e) => {
          seen.push(e.messageId);
          controller.abort();
        },
        fetchFn,
      },
      controller.signal,
    );
    expect(seen).toEqual(["m1"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toBe("http://x/v2/spaces/s1/chats/c1/messages/stream?heartbeat=30");
  });
});
