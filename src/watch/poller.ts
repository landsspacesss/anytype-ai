import type { AnytypeClient } from "../anytype/client.js";
import type { BlockSnap, WatchRecord } from "./store.js";
import { WatchStore, diffSnapshots, snapshotOf } from "./store.js";

/** Collapse whitespace and truncate for a one-line preview. "" for empty text. */
function preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length === 0) return "";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/** Drop blocks with no readable text (empty paragraphs, images, etc.). */
function withText<T extends { text: string }>(blocks: T[]): T[] {
  return blocks.filter((b) => preview(b.text).length > 0);
}

/**
 * Build a short human-readable change summary, e.g.
 * "新增 2 处、修改 1 处、删除 1 处" plus up to 3 previews of the changed/added
 * text ("修改" shows `old → new`). Blocks with no text are not previewed.
 */
export function summarizeChange(
  label: string,
  diff: {
    added: BlockSnap[];
    removed: BlockSnap[];
    changed: Array<{ id: string; text: string; oldText: string }>;
  },
): string {
  const counts: string[] = [];
  if (diff.added.length > 0) counts.push(`新增 ${diff.added.length} 处`);
  if (diff.changed.length > 0) counts.push(`修改 ${diff.changed.length} 处`);
  if (diff.removed.length > 0) counts.push(`删除 ${diff.removed.length} 处`);
  const head = `订阅的对象『${label}』内容有更新：${counts.join("、") || "内容变化"}。`;

  const previews: string[] = [];
  for (const b of withText(diff.changed).slice(0, 3)) {
    const oldT = preview(b.oldText);
    previews.push(oldT ? `- 修改：${oldT} → ${preview(b.text)}` : `- 修改：${preview(b.text)}`);
  }
  for (const b of withText(diff.added).slice(0, 3 - previews.length)) {
    previews.push(`- 新增：${preview(b.text)}`);
  }
  return previews.length > 0 ? `${head}\n${previews.join("\n")}` : head;
}

export interface PollDeps {
  store: WatchStore;
  api: AnytypeClient;
  notify: (rec: WatchRecord, text: string) => Promise<void>;
}

/**
 * Poll a single watched object once and notify on change.
 *
 * Anytype has no object-change event stream, so this is a poll + diff: fetch
 * the object, snapshot its blocks, and compare to the stored fingerprint. A
 * record whose object is gone (fetch throws) is reported and unsubscribed.
 * Never throws — a failure is logged so the caller can continue.
 */
export async function pollWatch(rec: WatchRecord, deps: PollDeps): Promise<void> {
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
      return;
    }

    const next = snapshotOf(doc);
    if (JSON.stringify(next) === JSON.stringify(rec.snapshot)) return; // unchanged

    const diff = diffSnapshots(rec.snapshot, next);
    await deps.notify(rec, summarizeChange(rec.label, diff));
    rec.snapshot = next;
    deps.store.save();
  } catch (err) {
    console.warn(`pollWatch: watch ${rec.objectId} failed: ${String(err)}`);
  }
}

/**
 * Poll EVERY watched object once, ignoring its schedule, and notify on change.
 * Used by tests and by the tool's `check`-all / on-demand paths; the scheduled
 * per-watch checks go through `pollDueWatches` instead. Failures are isolated
 * per record so one bad watch can't abort the poll.
 */
export async function pollWatches(deps: PollDeps): Promise<void> {
  for (const rec of deps.store.all()) {
    await pollWatch(rec, deps);
  }
}
