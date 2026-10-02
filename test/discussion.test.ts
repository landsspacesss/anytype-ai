import { describe, it, expect } from "vitest";
import { extractDiscussionId } from "../src/anytype/discussion.js";

describe("extractDiscussionId", () => {
  it("reads a top-level discussion id", () => {
    expect(extractDiscussionId({ id: "o1", discussion: "chat-abc" })).toBe("chat-abc");
  });

  it("falls back to properties.discussion_id array", () => {
    expect(extractDiscussionId({ properties: { discussion_id: ["chat-xyz"] } })).toBe("chat-xyz");
  });

  it("accepts properties.discussion_id as a plain string", () => {
    expect(extractDiscussionId({ properties: { discussion_id: "chat-1" } })).toBe("chat-1");
  });

  it("returns undefined when there is no discussion", () => {
    expect(extractDiscussionId({ id: "o1", type: "chat", properties: {} })).toBeUndefined();
  });

  it("is robust to malformed input", () => {
    expect(extractDiscussionId(null)).toBeUndefined();
    expect(extractDiscussionId(42)).toBeUndefined();
    expect(extractDiscussionId({ discussion: "" })).toBeUndefined();
    expect(extractDiscussionId({ properties: { discussion_id: [] } })).toBeUndefined();
  });
});
