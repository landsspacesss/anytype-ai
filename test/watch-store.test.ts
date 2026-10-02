import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WatchStore,
  snapshotOf,
  diffSnapshots,
  type WatchRecord,
} from "../src/watch/store.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-store-")), "watches.json");
}

function rec(over: Partial<WatchRecord> = {}): WatchRecord {
  return {
    objectId: "obj1",
    spaceId: "sp1",
    chatId: "chat1",
    label: "Note 1",
    snapshot: [{ id: "b1", text: "hi" }],
    cron: "*/30 * * * *",
    ...over,
  };
}

describe("snapshotOf", () => {
  it("extracts {id, text} from a document's blocks", () => {
    const doc = {
      blocks: [
        { id: "b1", type: "paragraph", text: "one" },
        { id: "b2", type: "image" },
        { id: "b3", type: "paragraph", text: "three" },
      ],
    };
    expect(snapshotOf(doc)).toEqual([
      { id: "b1", text: "one" },
      { id: "b2", text: "" },
      { id: "b3", text: "three" },
    ]);
  });

  it("skips blocks without a string id and is robust to malformed input", () => {
    expect(snapshotOf({ blocks: [null, 42, { text: 7 }, { text: "ok" }, { id: "keep", text: "yes" }] })).toEqual([
      { id: "keep", text: "yes" },
    ]);
    expect(snapshotOf(null)).toEqual([]);
    expect(snapshotOf({})).toEqual([]);
    expect(snapshotOf({ blocks: "nope" })).toEqual([]);
    expect(snapshotOf({ blocks: [{ id: "b1", text: 123 }] })).toEqual([{ id: "b1", text: "" }]);
  });
});

describe("diffSnapshots", () => {
  it("classifies added, removed, and changed blocks by id", () => {
    const oldSnaps = [
      { id: "a", text: "same" },
      { id: "b", text: "before" },
      { id: "c", text: "gone" },
    ];
    const newSnaps = [
      { id: "a", text: "same" },
      { id: "b", text: "after" },
      { id: "d", text: "fresh" },
    ];
    const diff = diffSnapshots(oldSnaps, newSnaps);
    expect(diff.added).toEqual([{ id: "d", text: "fresh" }]);
    expect(diff.removed).toEqual([{ id: "c", text: "gone" }]);
    expect(diff.changed).toEqual([{ id: "b", text: "after", oldText: "before" }]);
  });

  it("reports no differences for identical snapshots", () => {
    const snaps = [{ id: "a", text: "x" }];
    expect(diffSnapshots(snaps, snaps)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("WatchStore", () => {
  it("round-trips records through save/load", () => {
    const file = tmpFile();
    const a = new WatchStore(file);
    a.load();
    a.upsert(rec());
    a.upsert(rec({ objectId: "obj2", spaceId: "sp2", chatId: "chat2", label: "Note 2" }));
    a.save();

    const b = new WatchStore(file);
    b.load();
    expect(b.all()).toHaveLength(2);
    expect(b.get("sp1", "obj1")).toEqual(rec());
    expect(b.get("sp2", "obj2")?.label).toBe("Note 2");
  });

  it("round-trips cron and lastFiredMinute", () => {
    const file = tmpFile();
    const a = new WatchStore(file);
    a.load();
    a.upsert(rec({ cron: "0 9 * * 1-5", lastFiredMinute: "2026-10-02T09:00" }));
    a.save();

    const b = new WatchStore(file);
    b.load();
    const got = b.get("sp1", "obj1");
    expect(got?.cron).toBe("0 9 * * 1-5");
    expect(got?.lastFiredMinute).toBe("2026-10-02T09:00");
  });

  it("defaults cron for legacy records and tolerates a custom default", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        watches: [{ objectId: "old", spaceId: "sp1", chatId: "chat1", label: "Old", snapshot: [] }],
      }),
      "utf-8",
    );
    const store = new WatchStore(file);
    store.load();
    expect(store.get("sp1", "old")?.cron).toBe("*/30 * * * *");
    expect(store.get("sp1", "old")?.lastFiredMinute).toBeUndefined();

    const custom = new WatchStore(file, "0 9 * * *");
    custom.load();
    expect(custom.get("sp1", "old")?.cron).toBe("0 9 * * *");
  });

  it("upsert replaces an existing record and get/forSpace/remove work", () => {
    const store = new WatchStore(tmpFile());
    store.load();
    store.upsert(rec());
    store.upsert(rec({ label: "Renamed" }));
    expect(store.get("sp1", "obj1")?.label).toBe("Renamed");
    expect(store.forSpace("sp1")).toHaveLength(1);
    expect(store.forSpace("other")).toHaveLength(0);
    expect(store.remove("sp1", "obj1")).toBe(true);
    expect(store.remove("sp1", "obj1")).toBe(false);
    expect(store.get("sp1", "obj1")).toBeUndefined();
  });

  it("starts empty when the file does not exist or is corrupt", () => {
    const missing = new WatchStore(tmpFile());
    missing.load();
    expect(missing.all()).toEqual([]);

    const file = tmpFile();
    fs.writeFileSync(file, "{ this is not json", "utf-8");
    const corrupt = new WatchStore(file);
    corrupt.load();
    expect(corrupt.all()).toEqual([]);
  });

  it("skips malformed records but keeps valid ones", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        watches: [
          { objectId: "ok", spaceId: "sp1", chatId: "chat1", label: "L", snapshot: [{ id: "b", text: "t" }] },
          { objectId: "no-space", chatId: "chat1" },
          null,
          "junk",
        ],
      }),
      "utf-8",
    );
    const store = new WatchStore(file);
    store.load();
    expect(store.all()).toHaveLength(1);
    expect(store.get("sp1", "ok")?.label).toBe("L");
  });

  it("creates the parent directory on save", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-store-")), "nested", "deep");
    const file = path.join(dir, "watches.json");
    const store = new WatchStore(file);
    store.load();
    store.upsert(rec());
    store.save();
    expect(fs.existsSync(file)).toBe(true);
  });
});
