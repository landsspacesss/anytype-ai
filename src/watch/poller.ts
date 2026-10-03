import type { AnytypeClient } from "../anytype/client.js";
import type { BlockSnap, WatchRecord, WatchSource } from "./store.js";
import { WatchStore, diffSnapshots, snapshotOf, sourceOf } from "./store.js";

/** Default consecutive-404 threshold before a watch is dropped. */
const DEFAULT_MAX_MISSES = 3;

/** Collapse whitespace and truncate for a one-line preview. "" for empty text. */
function preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length === 0) return "";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/**
 * Blocks worth previewing: those with readable text, or a non-text content ref
 * (an image) — an image-only block has empty text but a meaningful `ref`.
 */
function withContent<T extends { text: string; ref?: string }>(blocks: T[]): T[] {
  return blocks.filter((b) => preview(b.text).length > 0 || !!b.ref);
}

/**
 * Build a short human-readable change summary, e.g.
 * "新增 2 处、修改 1 处、删除 1 处" plus up to 3 previews. A text block shows
 * `old → new`; an image block shows its file `object_id` (so the agent can fetch
 * exactly the changed image) — `换图` when the file changed, `新增图片` when new.
 */
export function summarizeChange(
  label: string,
  diff: {
    added: BlockSnap[];
    removed: BlockSnap[];
    changed: Array<{ id: string; text: string; oldText: string; ref?: string; oldRef?: string }>;
  },
): string {
  const counts: string[] = [];
  if (diff.added.length > 0) counts.push(`新增 ${diff.added.length} 处`);
  if (diff.changed.length > 0) counts.push(`修改 ${diff.changed.length} 处`);
  if (diff.removed.length > 0) counts.push(`删除 ${diff.removed.length} 处`);
  const head = `订阅的对象『${label}』内容有更新：${counts.join("、") || "内容变化"}。`;

  const previews: string[] = [];
  for (const b of withContent(diff.changed).slice(0, 3)) {
    if (preview(b.text).length > 0) {
      const oldT = preview(b.oldText);
      previews.push(oldT ? `- 修改：${oldT} → ${preview(b.text)}` : `- 修改：${preview(b.text)}`);
    } else if (b.ref) {
      previews.push(b.oldRef ? `- 换图：${b.oldRef} → ${b.ref}` : `- 换图：${b.ref}`);
    }
  }
  for (const b of withContent(diff.added).slice(0, 3 - previews.length)) {
    if (preview(b.text).length > 0) previews.push(`- 新增：${preview(b.text)}`);
    else if (b.ref) previews.push(`- 新增图片 object_id=${b.ref}`);
  }
  return previews.length > 0 ? `${head}\n${previews.join("\n")}` : head;
}

export interface PollDeps {
  store: WatchStore;
  api: AnytypeClient;
  notify: (rec: WatchRecord, text: string) => Promise<void>;
  /** Consecutive 404s before unsubscribing (guards against false drops). */
  maxMisses?: number;
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
    const source = sourceOf(rec);
    if (source.kind === "query") {
      await pollQuery(rec, source, deps);
      return;
    }

    let doc: unknown;
    try {
      doc = await deps.api.getObjectRaw(rec.spaceId, source.id);
    } catch (err) {
      // The read failed. Don't assume it's deleted — confirm via the object
      // list first (a soft-deleted object still reads 200, so absence from the
      // list is the real "gone" signal). A transient network/5xx failure leaves
      // the object present, so we keep the watch. Only N consecutive confirmed
      // absences drop it.
      let present: boolean | undefined;
      try {
        present = (await deps.api.listObjects(rec.spaceId)).some((o) => o.id === rec.objectId);
      } catch {
        present = undefined; // couldn't confirm → treat as transient, keep
      }
      if (present === false) {
        rec.misses = (rec.misses ?? 0) + 1;
        if (rec.misses >= (deps.maxMisses ?? DEFAULT_MAX_MISSES)) {
          try {
            await deps.notify(rec, `订阅的对象『${rec.label}』已不存在（连续 ${rec.misses} 次找不到），已取消订阅`);
          } catch {
            // Notification failure must not stop the removal.
          }
          deps.store.remove(rec.spaceId, rec.objectId);
        }
        deps.store.save();
      } else {
        console.warn(`pollWatch: watch ${rec.objectId} read failed but present=${present}; keeping: ${String(err)}`);
      }
      return;
    }

    // Success: the object is alive — clear any accumulated misses.
    if (rec.misses) {
      rec.misses = 0;
      deps.store.save();
    }

    let next = snapshotOf(doc);
    if (source.kind === "blocks") {
      // Only track the requested blocks (a passage / set of paragraphs).
      const keep = new Set(source.blockIds);
      next = next.filter((s) => keep.has(s.id));
    }
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
 * Poll a QUERY watch: the set of objects matching a search/filter. The stored
 * `snapshot` holds the matching objects as `{id, text:name}`, so a membership
 * change (an object entering/leaving the result) or a name change is a diff.
 * Never throws.
 */
async function pollQuery(rec: WatchRecord, source: WatchSource & { kind: "query" }, deps: PollDeps): Promise<void> {
  try {
    const items =
      source.filters !== undefined
        ? await deps.api.filteredSearch(rec.spaceId, { query: source.query, filters: source.filters })
        : await deps.api.search(rec.spaceId, source.query ?? "");
    const next: BlockSnap[] = items.map((o) => ({ id: o.id, text: o.name }));
    if (JSON.stringify(next) === JSON.stringify(rec.snapshot)) return; // unchanged
    const diff = diffSnapshots(rec.snapshot, next);
    await deps.notify(rec, summarizeQueryChange(rec.label, diff));
    rec.snapshot = next;
    deps.store.save();
  } catch (err) {
    console.warn(`pollWatch (query): watch ${rec.objectId} failed: ${String(err)}`);
  }
}

/** Human-readable summary for a query-watch change (objects entering/leaving). */
export function summarizeQueryChange(
  label: string,
  diff: {
    added: BlockSnap[];
    removed: BlockSnap[];
    changed: Array<{ id: string; text: string; oldText: string }>;
  },
): string {
  const counts: string[] = [];
  if (diff.added.length > 0) counts.push(`新增 ${diff.added.length} 个`);
  if (diff.removed.length > 0) counts.push(`移出 ${diff.removed.length} 个`);
  if (diff.changed.length > 0) counts.push(`改名 ${diff.changed.length} 个`);
  const head = `订阅的查询『${label}』结果有更新：${counts.join("、") || "有变化"}。`;
  const lines: string[] = [];
  for (const o of diff.added.slice(0, 5)) lines.push(`- 新增：${o.text || o.id}（${o.id}）`);
  for (const o of diff.removed.slice(0, 5)) lines.push(`- 移出：${o.text || o.id}（${o.id}）`);
  for (const o of diff.changed.slice(0, 5)) lines.push(`- 改名：${o.oldText} → ${o.text}（${o.id}）`);
  return lines.length > 0 ? `${head}\n${lines.join("\n")}` : head;
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
