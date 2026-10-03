import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirectOverrides } from "../src/router/direct-overrides.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "direct-ov-")), "direct-overrides.json");
}

describe("DirectOverrides", () => {
  it("sets, reads, and persists a per-space override", () => {
    const file = tmpFile();
    const a = new DirectOverrides(file);
    a.load();
    expect(a.get("pqdthe")).toBeUndefined();
    a.set("pqdthe", true);
    expect(a.get("pqdthe")).toBe(true);
    a.set("other", false);
    expect(a.get("other")).toBe(false);

    const b = new DirectOverrides(file);
    b.load();
    expect(b.get("pqdthe")).toBe(true);
    expect(b.get("other")).toBe(false);
    expect(b.get("nope")).toBeUndefined();
  });

  it("clears an override back to automatic", () => {
    const file = tmpFile();
    const a = new DirectOverrides(file);
    a.load();
    a.set("s1", true);
    a.clear("s1");
    expect(a.get("s1")).toBeUndefined();

    const b = new DirectOverrides(file);
    b.load();
    expect(b.get("s1")).toBeUndefined();
  });

  it("starts empty on a missing or corrupt file", () => {
    const missing = new DirectOverrides(tmpFile());
    missing.load();
    expect(missing.get("x")).toBeUndefined();

    const file = tmpFile();
    fs.writeFileSync(file, "{ not json", "utf-8");
    const corrupt = new DirectOverrides(file);
    corrupt.load();
    expect(corrupt.get("x")).toBeUndefined();
  });

  it("ignores non-boolean entries on load", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ spaces: { a: true, b: "yes", c: 1, d: false } }), "utf-8");
    const store = new DirectOverrides(file);
    store.load();
    expect(store.get("a")).toBe(true);
    expect(store.get("d")).toBe(false);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeUndefined();
  });
});
