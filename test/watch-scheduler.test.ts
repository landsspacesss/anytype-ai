import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WatchStore, type WatchRecord } from "../src/watch/store.js";
import { pollDueWatches, minuteKey } from "../src/watch/scheduler.js";
import type { AnytypeClient } from "../src/anytype/client.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-sched-")), "watches.json");
}

function docWith(texts: Record<string, string>): unknown {
  return { blocks: Object.entries(texts).map(([id, text]) => ({ id, type: "paragraph", text })) };
}

function storeWith(rec: Partial<WatchRecord>): WatchStore {
  const store = new WatchStore(tmpFile());
  store.load();
  store.upsert({
    objectId: "obj1",
    spaceId: "sp1",
    chatId: "chat1",
    label: "Note 1",
    snapshot: [{ id: "b1", text: "old" }],
    cron: "* * * * *",
    ...rec,
  });
  return store;
}

describe("minuteKey", () => {
  it("formats a local YYYY-MM-DDTHH:MM key", () => {
    expect(minuteKey(new Date(2026, 9, 2, 9, 5))).toBe("2026-10-02T09:05");
  });
});

describe("pollDueWatches", () => {
  it("fires a matching watch once per minute (not twice in the same minute)", async () => {
    const store = storeWith({ cron: "* * * * *" });
    // Each fetch returns new content so each successful poll is a change.
    let n = 0;
    const api = {
      getObjectRaw: vi.fn(async () => docWith({ b1: `v${++n}` })),
    } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});
    const now = new Date(2026, 9, 2, 9, 0);

    await pollDueWatches({ store, api, notify, now: () => now });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.get("sp1", "obj1")?.lastFiredMinute).toBe("2026-10-02T09:00");

    // Same minute again -> no second fire.
    await pollDueWatches({ store, api, notify, now: () => now });
    expect(notify).toHaveBeenCalledTimes(1);

    // Next minute -> fires again.
    await pollDueWatches({ store, api, notify, now: () => new Date(2026, 9, 2, 9, 1) });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not fire a watch whose cron does not match", async () => {
    const store = storeWith({ cron: "0 9 * * *" });
    const api = { getObjectRaw: vi.fn(async () => docWith({ b1: "new" })) } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollDueWatches({ store, api, notify, now: () => new Date(2026, 9, 2, 9, 30) });

    expect(api.getObjectRaw).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("isolates a failing record so others still fire", async () => {
    const store = new WatchStore(tmpFile());
    store.load();
    store.upsert({ objectId: "bad", spaceId: "sp1", chatId: "c", label: "Bad", snapshot: [], cron: "* * * * *" });
    store.upsert({
      objectId: "good",
      spaceId: "sp1",
      chatId: "c",
      label: "Good",
      snapshot: [{ id: "b1", text: "x" }],
      cron: "* * * * *",
    });
    // Make the FIRST save (marking "bad" as fired) throw, simulating a failure
    // mid-processing; the loop must still reach and notify "good".
    let saves = 0;
    const realSave = store.save.bind(store);
    store.save = () => {
      saves++;
      if (saves === 1) throw new Error("save boom");
      realSave();
    };
    const api = { getObjectRaw: vi.fn(async () => docWith({ b1: "x", b2: "new" })) } as unknown as AnytypeClient;
    const notify = vi.fn(async () => {});

    await pollDueWatches({ store, api, notify, now: () => new Date(2026, 9, 2, 9, 0) });

    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as unknown as [WatchRecord, string])[0].objectId).toBe("good");
  });
});
