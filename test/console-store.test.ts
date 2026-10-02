import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConsole, writeConsole } from "../src/console/console-store.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "console.json");
}

describe("console store", () => {
  it("round-trips a record", () => {
    const f = tmpFile();
    writeConsole(f, { spaceId: "abc", chatId: "c1", bootstrappedAt: "2026-10-02T00:00:00Z" });
    expect(readConsole(f)).toEqual({ spaceId: "abc", chatId: "c1", bootstrappedAt: "2026-10-02T00:00:00Z" });
  });

  it("returns null when the file is missing", () => {
    expect(readConsole(path.join(os.tmpdir(), "nope-does-not-exist.json"))).toBeNull();
  });

  it("returns null on a malformed record (missing spaceId)", () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ chatId: "c1" }));
    expect(readConsole(f)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    const f = tmpFile();
    fs.writeFileSync(f, "{not json");
    expect(readConsole(f)).toBeNull();
  });

  it("writes pretty JSON and creates parent dirs", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "nested", "console.json");
    writeConsole(f, { spaceId: "abc", bootstrappedAt: "t" });
    expect(fs.readFileSync(f, "utf-8")).toContain('"spaceId": "abc"');
  });
});
