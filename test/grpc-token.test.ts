import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionToken } from "../src/anytype/grpc.js";

describe("readSessionToken", () => {
  it("reads sessionToken from a CLI config.json", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "config.json");
    fs.writeFileSync(f, JSON.stringify({ sessionToken: "tok123", accountKey: "ak" }));
    expect(readSessionToken(f)).toBe("tok123");
  });
  it("returns null when missing/unreadable/malformed", () => {
    expect(readSessionToken("/nope/not-here.json")).toBeNull();
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "config.json");
    fs.writeFileSync(f, "{bad");
    expect(readSessionToken(f)).toBeNull();
  });
});
