import { describe, it, expect } from "vitest";
import { resolveBotParticipantId } from "../src/anytype/members.js";

const BOT_IDENTITY =
  "A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm";

describe("resolveBotParticipantId", () => {
  it("returns the participant id of the member whose identity matches", () => {
    const members = [
      { id: "_participant_space_AAA", identity: "AAA", name: "user" },
      { id: `_participant_space_${BOT_IDENTITY}`, identity: BOT_IDENTITY, name: "anytype-bot" },
    ];
    expect(resolveBotParticipantId(members, BOT_IDENTITY)).toBe(
      `_participant_space_${BOT_IDENTITY}`,
    );
  });

  it("returns undefined when no member matches the identity", () => {
    const members = [{ id: "p1", identity: "someone-else", name: "user" }];
    expect(resolveBotParticipantId(members, BOT_IDENTITY)).toBeUndefined();
  });

  it("returns undefined when botIdentity is unset or empty", () => {
    const members = [{ id: "p1", identity: BOT_IDENTITY }];
    expect(resolveBotParticipantId(members, undefined)).toBeUndefined();
    expect(resolveBotParticipantId(members, "")).toBeUndefined();
  });
});
