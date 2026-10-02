import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WatchStore, type WatchRecord } from "../src/watch/store.js";
import { pollWatches, summarizeChange } from "../src/watch/poller.js";
import type { AnytypeClient } from "../src/anytype/client.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-poll-")), "watches.json");
}

function docWith(texts: Record<string, string>): unknown {
  return { blocks: Object.entries(texts).map(([id, text]) => ({ id, type: "paragraph", text })) };
}

function seededStore(snapshot: Array<{ id: string; text: string }>): WatchStore {
  const store = new WatchStore(tmpFile());
  store.load();
  store.upsert({ objectId: "obj1", spaceId: "sp1", chatId: "chat1", label: "Note 1", snapshot });
  return store;
}

describe("summarizeChange", () => {
  it("counts each change kind and previews changed/added text", () => {
    const summary = summarizeChange("Note 1", {
      added: [{ id: "n1", text: "brand new" }],
      removed: [{ id: "r1", text: "old" }],
      changed: [{ id: "c1", text: "updated text", oldText: "old text" }],
    });
    expect(summary).toContain("Note 1");
    expect(summary).toContain("新增 1 处");
    expect(summary).toContain("修改 1 处");
    expect(summary).toContain("删除 1 处");
    expect(summary).toContain("old text → updated text");
    expect(summary).toContain("brand new");
  });

  it("skips empty-text blocks in the previews", () => {
    const summary = summarizeChange("Note 2", {
      added: [{ id: "e1", text: "" }],
      removed: [],
      changed: [],
    });
    expect(summary).toContain("新增 1 处"); // still counted
    expect(summary).not.toContain("新增：");
  });
});

describe("pollWatches", () => {
  it("does not notify when a freshly-added watch is unchanged", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = { getObjectRaw: vi.fn(async () => docWith({ b1: "hello" })) } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    expect(api.getObjectRaw).toHaveBeenCalledWith("sp1", "obj1");
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies once on change and updates the stored snapshot", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = {
      getObjectRaw: vi.fn(async () => docWith({ b1: "hello changed", b2: "added" })),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    expect(notify).toHaveBeenCalledTimes(1);
    const [rec, text] = notify.mock.calls[0] as unknown as [WatchRecord, string];
    expect(rec.objectId).toBe("obj1");
    expect(text).toContain("Note 1");
    expect(text).toContain("修改 1 处");
    expect(text).toContain("新增 1 处");
    // snapshot advanced to the new state, and was persisted
    expect(store.get("sp1", "obj1")?.snapshot).toEqual([
      { id: "b1", text: "hello changed" },
      { id: "b2", text: "added" },
    ]);

    // A second poll with no further change does not notify again.
    await pollWatches({ store, api, notify });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies and unsubscribes when the object fetch fails", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = {
      getObjectRaw: vi.fn(async () => {
        throw new Error("getObjectRaw failed: 404");
      }),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as unknown as [WatchRecord, string])[1]).toContain("已不存在");
    expect(store.get("sp1", "obj1")).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it("isolates a failing record so other watches still poll", async () => {
    const store = new WatchStore(tmpFile());
    store.load();
    store.upsert({ objectId: "bad", spaceId: "sp1", chatId: "c", label: "Bad", snapshot: [] });
    store.upsert({ objectId: "good", spaceId: "sp1", chatId: "c", label: "Good", snapshot: [] });
    const api = {
      getObjectRaw: vi.fn(async (_space: string, id: string) => {
        if (id === "bad") throw new Error("boom");
        return docWith({ b1: "x" });
      }),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    // bad -> unsubscribed with a notice; good -> changed ([] -> [b1]) so notified.
    expect(store.get("sp1", "bad")).toBeUndefined();
    expect(store.get("sp1", "good")).toBeDefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
