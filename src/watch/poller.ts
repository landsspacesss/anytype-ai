import type { AnytypeClient } from "../anytype/client.js";
import type { BlockSnap, WatchRecord } from "./store.js";
import { WatchStore, diffSnapshots, snapshotOf } from "./store.js";

/** Collapse whitespace and truncate for a one-line preview. */
function preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length === 0) return "(空)";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/**
 * Build a short human-readable change summary, e.g.
 * "新增 2 处、修改 1 处、删除 1 处" plus up to 3 previews of changed/added text.
 */
export function summarizeChange(
  label: string,
  diff: { added: BlockSnap[]; removed: BlockSnap[]; changed: BlockSnap[] },
): string {
  const counts: string[] = [];
  if (diff.added.length > 0) counts.push(`新增 ${diff.added.length} 处`);
  if (diff.changed.length > 0) counts.push(`修改 ${diff.changed.length} 处`);
  if (diff.removed.length > 0) counts.push(`删除 ${diff.removed.length} 处`);
  const head = `订阅的对象『${label}』内容有更新：${counts.join("、") || "内容变化"}。`;

  const previews: string[] = [];
  for (const b of diff.changed.slice(0, 3)) previews.push(`- 修改：${preview(b.text)}`);
  for (const b of diff.added.slice(0, 3 - previews.length)) previews.push(`- 新增：${preview(b.text)}`);
  return previews.length > 0 ? `${head}\n${previews.join("\n")}` : head;
}

export interface PollDeps {
  store: WatchStore;
  api: AnytypeClient;
  notify: (rec: WatchRecord, text: string) => Promise<void>;
}

/**
 * Poll every watched object once and notify the originating chat on change.
 *
 * Anytype has no object-change event stream, so this is a poll + diff: fetch
 * each object, snapshot its blocks, and compare to the stored fingerprint. A
 * record whose object is gone (fetch throws) is reported and unsubscribed.
 * Failures are isolated per record so one bad watch can't abort the poll.
 */
export async function pollWatches(deps: PollDeps): Promise<void> {
  for (const rec of deps.store.all()) {
    try {
      let doc: unknown;
      try {
        doc = await deps.api.getObjectRaw(rec.spaceId, rec.objectId);
      } catch {
        // Object missing/deleted (or otherwise unreadable): notify + unsubscribe.
        try {
          await deps.notify(rec, `订阅的对象『${rec.label}』已不存在，已取消订阅`);
        } catch {
          // Notification failure must not stop the removal.
        }
        deps.store.remove(rec.spaceId, rec.objectId);
        deps.store.save();
        continue;
      }

      const next = snapshotOf(doc);
      if (JSON.stringify(next) === JSON.stringify(rec.snapshot)) continue; // unchanged

      const diff = diffSnapshots(rec.snapshot, next);
      await deps.notify(rec, summarizeChange(rec.label, diff));
      rec.snapshot = next;
      deps.store.save();
    } catch (err) {
      console.warn(`pollWatches: watch ${rec.objectId} failed: ${String(err)}`);
    }
  }
}
