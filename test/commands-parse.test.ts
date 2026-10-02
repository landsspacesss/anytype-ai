import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/commands/parse.js";

describe("parseCommand", () => {
  it("parses /new with no args", () => {
    expect(parseCommand("/new")).toEqual({ command: "new", args: "" });
  });

  it("parses /model with an argument", () => {
    expect(parseCommand("/model gpt")).toEqual({ command: "model", args: "gpt" });
  });

  it("parses /compact", () => {
    expect(parseCommand("/compact")).toEqual({ command: "compact", args: "" });
  });

  it("parses a bare slash as an empty command", () => {
    expect(parseCommand("/")).toEqual({ command: "", args: "" });
  });

  it("returns null for plain text", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  it("lowercases the command but preserves arg case", () => {
    expect(parseCommand("/Model DeepSeek")).toEqual({ command: "model", args: "DeepSeek" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseCommand("  /effort high  ")).toEqual({ command: "effort", args: "high" });
  });
});
