import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WatchStore, type WatchRecord } from "../src/watch/store.js";
import { pollWatch, pollWatches, summarizeChange } from "../src/watch/poller.js";
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
  store.upsert({ objectId: "obj1", spaceId: "sp1", chatId: "chat1", label: "Note 1", snapshot, cron: "*/30 * * * *" });
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

describe("pollWatch", () => {
  it("notifies and advances the snapshot for a single record", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const rec = store.get("sp1", "obj1")!;
    const api = { getObjectRaw: vi.fn(async () => docWith({ b1: "changed" })) } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatch(rec, { store, api, notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(rec.snapshot).toEqual([{ id: "b1", text: "changed" }]);
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

  it("does NOT unsubscribe when a read fails but the object is still listed", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = {
      getObjectRaw: vi.fn(async () => {
        throw new Error("fetch failed: ECONNRESET"); // transient blip
      }),
      listObjects: vi.fn(async () => [{ id: "obj1", name: "Note 1", type: "page" }]), // still present
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    expect(notify).not.toHaveBeenCalled();
    expect(store.get("sp1", "obj1")).toBeDefined(); // kept
  });

  it("probes the list when a read fails, and unsubscribes only after N confirmed absences", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = {
      getObjectRaw: vi.fn(async () => {
        throw new Error("read failed");
      }),
      listObjects: vi.fn(async () => []), // absent → confirms deletion
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatch(store.get("sp1", "obj1")!, { store, api, notify, maxMisses: 3 });
    await pollWatch(store.get("sp1", "obj1")!, { store, api, notify, maxMisses: 3 });
    expect(store.get("sp1", "obj1")).toBeDefined(); // 2 misses — not yet
    expect(notify).not.toHaveBeenCalled();

    await pollWatch(store.get("sp1", "obj1")!, { store, api, notify, maxMisses: 3 });
    expect(store.get("sp1", "obj1")).toBeUndefined(); // 3rd confirmed absence — dropped
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as unknown as [WatchRecord, string])[1]).toContain("已不存在");
  });

  it("does not unsubscribe when neither the read nor the list can confirm absence", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    const api = {
      getObjectRaw: vi.fn(async () => {
        throw new Error("read failed");
      }),
      listObjects: vi.fn(async () => {
        throw new Error("list also failed");
      }),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(store.get("sp1", "obj1")).toBeDefined(); // can't confirm → keep
  });

  it("resets the miss counter when the object is readable again", async () => {
    const store = seededStore([{ id: "b1", text: "hello" }]);
    let fail = true;
    const api = {
      getObjectRaw: vi.fn(async () => {
        if (fail) throw new Error("read failed");
        return docWith({ b1: "hello" }); // unchanged content
      }),
      listObjects: vi.fn(async () => []), // absent while failing
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatch(store.get("sp1", "obj1")!, { store, api, notify, maxMisses: 3 });
    expect(store.get("sp1", "obj1")?.misses).toBe(1);
    fail = false;
    await pollWatch(store.get("sp1", "obj1")!, { store, api, notify, maxMisses: 3 });
    expect(store.get("sp1", "obj1")?.misses).toBe(0);
    expect(store.get("sp1", "obj1")).toBeDefined();
  });

  it("isolates a failing record so other watches still poll", async () => {
    const store = new WatchStore(tmpFile());
    store.load();
    store.upsert({ objectId: "bad", spaceId: "sp1", chatId: "c", label: "Bad", snapshot: [], cron: "* * * * *" });
    store.upsert({ objectId: "good", spaceId: "sp1", chatId: "c", label: "Good", snapshot: [], cron: "* * * * *" });
    const api = {
      getObjectRaw: vi.fn(async (_space: string, id: string) => {
        if (id === "bad") throw new Error("boom"); // transient
        return docWith({ b1: "x" });
      }),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollWatches({ store, api, notify });

    // bad -> transient, kept; good -> changed ([] -> [b1]) so notified.
    expect(store.get("sp1", "bad")).toBeDefined();
    expect(store.get("sp1", "good")).toBeDefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
