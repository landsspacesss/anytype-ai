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

  it("drops replayed backlog older than `since` but keeps newer and missing-`at`", () => {
    const since = "2026-10-01T17:18:17Z";
    const msg = (id: string, at?: string) => ({
      id: "st",
      type: "message_added",
      message: { id, author_id: "u1", text: "hi", ...(at === undefined ? {} : { at }) },
    });
    const onEvent = vi.fn();

    // Strictly older than `since` -> backlog -> dropped.
    handleEvent(msg("old", "2026-10-01T17:18:16Z"), ctx, onEvent, since);
    expect(onEvent).not.toHaveBeenCalled();

    // Equal to `since` -> delivered.
    handleEvent(msg("equal", "2026-10-01T17:18:17Z"), ctx, onEvent, since);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({ messageId: "equal" });

    // Newer than `since` -> delivered.
    handleEvent(msg("new", "2026-10-01T17:18:18Z"), ctx, onEvent, since);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[1][0]).toMatchObject({ messageId: "new" });

    // Missing `at` -> fails open -> delivered.
    handleEvent(msg("noat"), ctx, onEvent, since);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[2][0]).toMatchObject({ messageId: "noat" });

    // Without `since`, even old messages are delivered (no filtering).
    handleEvent(msg("old2", "2026-10-01T17:00:00Z"), ctx, onEvent);
    expect(onEvent).toHaveBeenCalledTimes(4);
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

  it("threads `since` through and drops replayed backlog messages", async () => {
    const sse =
      'data: {"id":"1","type":"message_added","message":{"id":"old","author_id":"u1","text":"stale","at":"2026-10-01T17:18:16Z"}}\n\n' +
      'data: {"id":"2","type":"message_added","message":{"id":"live","author_id":"u1","text":"new","at":"2026-10-01T17:18:17Z"}}\n\n';
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
        since: "2026-10-01T17:18:17Z",
        onEvent: (e) => {
          seen.push(e.messageId);
          controller.abort();
        },
        fetchFn,
      },
      controller.signal,
    );
    expect(seen).toEqual(["live"]);
  });
});
