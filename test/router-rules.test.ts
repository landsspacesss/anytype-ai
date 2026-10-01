import { describe, it, expect } from "vitest";
import { shouldTrigger, stripBotMention } from "../src/router/rules.js";
import type { NormalizedEvent } from "../src/types.js";

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    spaceId: "s", chatId: "c", messageId: "m", senderId: "u",
    text: "hi", mentionsBot: false, isBotSelf: false, isDirect: false,
    ...partial,
  };
}

describe("shouldTrigger", () => {
  it("triggers on mention in a group chat", () => {
    expect(shouldTrigger(ev({ mentionsBot: true }))).toBe(true);
  });
  it("triggers on every DM message", () => {
    expect(shouldTrigger(ev({ isDirect: true }))).toBe(true);
  });
  it("does not trigger without mention in a group chat", () => {
    expect(shouldTrigger(ev({}))).toBe(false);
  });
  it("never triggers on the bot's own message", () => {
    expect(shouldTrigger(ev({ isBotSelf: true, mentionsBot: true }))).toBe(false);
    expect(shouldTrigger(ev({ isBotSelf: true, isDirect: true }))).toBe(false);
  });
});

describe("stripBotMention", () => {
  it("removes a leading @name and trims", () => {
    expect(stripBotMention("@ai what is 2+2", "ai")).toBe("what is 2+2");
  });
  it("removes an inline @name", () => {
    expect(stripBotMention("hey @ai help", "ai")).toBe("hey  help".replace(/\s+/g, " ").trim());
  });
  it("leaves text unchanged when no mention", () => {
    expect(stripBotMention("hello", "ai")).toBe("hello");
  });
  it("strips the real Anytype mention tag", () => {
    expect(
      stripBotMention(
        '<mention object_id="_participant_X_Y">anytype-bot</mention> hello',
        "anytype-bot",
      ),
    ).toBe("hello");
  });
});
