import { describe, it, expect } from "vitest";
import { normalizeMessage, parseSseChunk } from "../src/anytype/events.js";

describe("normalizeMessage", () => {
  it("marks a message mentioning the bot", () => {
    const raw = {
      id: "m1", chat_id: "c1", space_id: "s1",
      creator: "u1", text: "@ai hi",
      mentions: [{ participant_id: "bot1" }],
    };
    const e = normalizeMessage(raw, { botParticipantId: "bot1", isDirect: false });
    expect(e?.mentionsBot).toBe(true);
    expect(e?.isBotSelf).toBe(false);
    expect(e?.chatId).toBe("c1");
  });

  it("flags the bot's own message", () => {
    const raw = { id: "m2", chat_id: "c1", space_id: "s1", creator: "bot1", text: "ok", mentions: [] };
    const e = normalizeMessage(raw, { botParticipantId: "bot1", isDirect: false });
    expect(e?.isBotSelf).toBe(true);
  });

  it("returns null for malformed input", () => {
    expect(normalizeMessage({}, { botParticipantId: "bot1", isDirect: false })).toBeNull();
  });
});

describe("parseSseChunk", () => {
  it("extracts complete events and keeps the remainder", () => {
    const { events, rest } = parseSseChunk("data: {\"a\":1}\n\ndata: {\"b\"");
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b"');
  });
});
