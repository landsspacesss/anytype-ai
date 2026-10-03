import fs from "node:fs";
import path from "node:path";

/** A compact snapshot of one block: its id plus its text (fingerprint + diff unit). */
export interface BlockSnap {
  id: string;
  text: string;
  /**
   * Content reference that changes when a non-text block's content changes —
   * for an image block, its `object_id` (the file object). Without this an
   * image swap is invisible: same block id, same empty text.
   */
  ref?: string;
}

/**
 * One object-change subscription: which object to watch, in which space, and
 * which chat to notify in (the chat the subscription was made from). `snapshot`
 * is the last-seen block state — the change fingerprint and the diff base.
 *
 * `cron` is the 5-field schedule (local time) at which the object is checked;
 * `lastFiredMinute` records the local minute key (`YYYY-MM-DDTHH:MM`) of the last
 * fire so a watch fires at most once per matching minute (crash-safe re-entry).
 */
export interface WatchRecord {
  objectId: string;
  spaceId: string;
  chatId: string;
  label: string;
  snapshot: BlockSnap[];
  cron: string;
  /**
   * Optional instruction for the AI to run when this object changes (e.g.
   * "总结这篇文章的变化"). When set, a change triggers an agent turn in the
   * watch's chat instead of just posting the raw diff.
   */
  prompt?: string;
  lastFiredMinute?: string;
  /**
   * Consecutive "object not found (404)" observations. Only after this reaches
   * the configured max do we treat the object as truly deleted and unsubscribe;
   * transient network/5xx failures never increment it. Reset on any success.
   */
  misses?: number;
}

/**
 * Extract a compact `{id, text, ref?}` snapshot from an Anytype document's
 * `blocks`. Only string ids are kept (a block without a string id can't be
 * tracked); a non-string/absent `text` becomes "". An image block also carries
 * its `object_id` as `ref`, so a re-uploaded image (same block, new file) is
 * detectable. Robust to missing/malformed fields.
 */
export function snapshotOf(doc: unknown): BlockSnap[] {
  if (doc === null || typeof doc !== "object") return [];
  const blocks = (doc as Record<string, unknown>).blocks;
  if (!Array.isArray(blocks)) return [];
  const out: BlockSnap[] = [];
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (typeof block.id !== "string") continue;
    const snap: BlockSnap = {
      id: block.id,
      text: typeof block.text === "string" ? block.text : "",
    };
    if (typeof block.object_id === "string" && block.object_id.length > 0) {
      snap.ref = block.object_id;
    }
    out.push(snap);
  }
  return out;
}

/** Whether a block's rendered content differs between two snapshots. */
function blockChanged(old: BlockSnap, next: BlockSnap): boolean {
  if (old.text !== next.text) return true;
  // Non-text content (e.g. an image's file): a swap is a change — but ONLY once
  // both sides recorded a ref. This makes a snapshot written before refs existed
  // re-baseline silently on the next poll instead of reporting every image as
  // changed (see `ref` on BlockSnap).
  if (old.ref !== undefined && next.ref !== undefined && old.ref !== next.ref) return true;
  return false;
}

/**
 * Diff two snapshots by block id: ids only in `newSnaps` are added, ids only in
 * `oldSnaps` are removed, and ids in both whose text OR content-ref changed are
 * changed (a ref-only change is an image swap).
 */
export function diffSnapshots(
  oldSnaps: BlockSnap[],
  newSnaps: BlockSnap[],
): {
  added: BlockSnap[];
  removed: BlockSnap[];
  changed: Array<{ id: string; text: string; oldText: string; ref?: string; oldRef?: string }>;
} {
  const oldById = new Map(oldSnaps.map((s) => [s.id, s]));
  const newById = new Map(newSnaps.map((s) => [s.id, s]));
  const added = newSnaps.filter((s) => !oldById.has(s.id));
  const removed = oldSnaps.filter((s) => !newById.has(s.id));
  const changed = newSnaps.flatMap((s) => {
    const old = oldById.get(s.id);
    if (!old || !blockChanged(old, s)) return [];
    const entry: { id: string; text: string; oldText: string; ref?: string; oldRef?: string } = {
      id: s.id,
      text: s.text,
      oldText: old.text,
    };
    if (s.ref !== undefined) entry.ref = s.ref;
    if (old.ref !== undefined) entry.oldRef = old.ref;
    return [entry];
  });
  return { added, removed, changed };
}

/** Fallback cron for legacy records loaded without a schedule field. */
export const DEFAULT_WATCH_CRON = "*/30 * * * *";

/**
 * Durable set of object-change subscriptions, backed by a single JSON file
 * (`{ "watches": WatchRecord[] }`). Records are keyed by (spaceId, objectId).
 * A missing or corrupt file is tolerated: the store simply starts empty.
 *
 * `defaultCron` is applied to legacy records that predate the `cron` field.
 */
export class WatchStore {
  private records = new Map<string, WatchRecord>();
  private loaded = false;

  constructor(private filePath: string, private defaultCron: string = DEFAULT_WATCH_CRON) {}

  private key(spaceId: string, objectId: string): string {
    return `${spaceId}::${objectId}`;
  }

  /** Read the JSON file into memory. Tolerates a missing/corrupt file (starts empty). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { watches?: unknown };
      const arr = Array.isArray(parsed?.watches) ? parsed.watches : [];
      for (const r of arr) {
        if (r === null || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        if (
          typeof rec.objectId !== "string" ||
          typeof rec.spaceId !== "string" ||
          typeof rec.chatId !== "string"
        ) {
          continue;
        }
        const snapshot = Array.isArray(rec.snapshot)
          ? rec.snapshot
              .filter((s) => s !== null && typeof s === "object" && typeof (s as BlockSnap).id === "string")
              .map((s) => {
                const b = s as Record<string, unknown>;
                const snap: BlockSnap = { id: b.id as string, text: typeof b.text === "string" ? b.text : "" };
                if (typeof b.ref === "string" && b.ref.length > 0) snap.ref = b.ref;
                return snap;
              })
          : [];
        const label = typeof rec.label === "string" ? rec.label : rec.objectId;
        const cron = typeof rec.cron === "string" && rec.cron.length > 0 ? rec.cron : this.defaultCron;
        const record: WatchRecord = {
          objectId: rec.objectId,
          spaceId: rec.spaceId,
          chatId: rec.chatId,
          label,
          snapshot,
          cron,
        };
        if (typeof rec.lastFiredMinute === "string") record.lastFiredMinute = rec.lastFiredMinute;
        if (typeof rec.misses === "number" && rec.misses > 0) record.misses = rec.misses;
        if (typeof rec.prompt === "string" && rec.prompt.trim().length > 0) record.prompt = rec.prompt.trim();
        this.records.set(this.key(rec.spaceId, rec.objectId), record);
      }
    } catch {
      // Missing or corrupt file — start empty rather than crash.
      this.records.clear();
    }
  }

  all(): WatchRecord[] {
    return [...this.records.values()];
  }

  forSpace(spaceId: string): WatchRecord[] {
    return this.all().filter((r) => r.spaceId === spaceId);
  }

  get(spaceId: string, objectId: string): WatchRecord | undefined {
    return this.records.get(this.key(spaceId, objectId));
  }

  upsert(rec: WatchRecord): void {
    this.records.set(this.key(rec.spaceId, rec.objectId), rec);
  }

  remove(spaceId: string, objectId: string): boolean {
    return this.records.delete(this.key(spaceId, objectId));
  }

  /** Persist all records as JSON, creating the parent directory if needed. */
  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ watches: this.all() }, null, 2), "utf-8");
  }
}
