import { describe, it, expect } from "vitest";
import { normalizeMessage, hasMentionOf, parseSseChunk } from "../src/anytype/events.js";

const BOT_PID =
  "_participant_bafyreia3tvojsim3dcxu6amtct5m2pjriwcj52tlpmgcrdwk7nrypqdthe_2reb8xis4pogu_A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm";

describe("normalizeMessage", () => {
  it("marks a message mentioning the bot by its participant id", () => {
    const raw = {
      id: "bafyreib635hbfyb5metl3tbndmgxzjqyyxdj6qqevwbil3hencqgzqlanm",
      order: "!!%>",
      author: "anytype-bot",
      author_id: BOT_PID,
      at: "2026-10-01T17:17:11Z",
      text: `<mention object_id="${BOT_PID}">anytype-bot</mention> hello`,
    };
    const e = normalizeMessage(raw, {
      spaceId: "s1",
      chatId: "c1",
      botParticipantId: BOT_PID,
      isDirect: false,
    });
    expect(e?.mentionsBot).toBe(true);
    expect(e?.isBotSelf).toBe(true);
    expect(e?.spaceId).toBe("s1");
    expect(e?.chatId).toBe("c1");
  });

  it("marks a bot-authored message as bot self", () => {
    const raw = { id: "m2", author_id: "bot1", text: "ok" };
    const e = normalizeMessage(raw, {
      spaceId: "s1",
      chatId: "c1",
      botParticipantId: "bot1",
      isDirect: false,
    });
    expect(e?.isBotSelf).toBe(true);
    expect(e?.mentionsBot).toBe(false);
  });

  it("returns null for malformed input", () => {
    const ctx = { spaceId: "s1", chatId: "c1", botParticipantId: "bot1", isDirect: false };
    expect(normalizeMessage({}, ctx)).toBeNull();
    expect(normalizeMessage({ id: "m1" }, ctx)).toBeNull();
    expect(normalizeMessage({ author_id: "bot1" }, ctx)).toBeNull();
  });

  it("does not flag a mention of a different participant", () => {
    const raw = {
      id: "m3",
      author_id: "u1",
      text: '<mention object_id="_participant_other_abc">someone</mention> hi',
    };
    const e = normalizeMessage(raw, {
      spaceId: "s1",
      chatId: "c1",
      botParticipantId: BOT_PID,
      isDirect: false,
    });
    expect(e?.mentionsBot).toBe(false);
  });
});

describe("hasMentionOf", () => {
  it("detects the real inline mention tag", () => {
    expect(hasMentionOf(`<mention object_id="${BOT_PID}">anytype-bot</mention> hi`, BOT_PID)).toBe(true);
    expect(hasMentionOf("<mention object_id=\"other\">x</mention>", BOT_PID)).toBe(false);
    expect(hasMentionOf("no tags here", BOT_PID)).toBe(false);
  });
});

describe("parseSseChunk", () => {
  it("extracts complete events and keeps the remainder", () => {
    const { events, rest } = parseSseChunk("data: {\"a\":1}\n\ndata: {\"b\"");
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b"');
  });
});
