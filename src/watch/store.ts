import fs from "node:fs";
import path from "node:path";

/** A compact snapshot of one block: its id plus its text (fingerprint + diff unit). */
export interface BlockSnap {
  id: string;
  text: string;
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
  lastFiredMinute?: string;
  /**
   * Consecutive "object not found (404)" observations. Only after this reaches
   * the configured max do we treat the object as truly deleted and unsubscribe;
   * transient network/5xx failures never increment it. Reset on any success.
   */
  misses?: number;
}

/**
 * Extract a compact `{id, text}` snapshot from an Anytype document's `blocks`.
 * Only string ids are kept (a block without a string id can't be tracked); a
 * non-string/absent `text` becomes "". Robust to missing/malformed fields.
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
    out.push({ id: block.id, text: typeof block.text === "string" ? block.text : "" });
  }
  return out;
}

/**
 * Diff two snapshots by block id: ids only in `newSnaps` are added, ids only in
 * `oldSnaps` are removed, and ids in both whose text changed are changed.
 */
export function diffSnapshots(
  oldSnaps: BlockSnap[],
  newSnaps: BlockSnap[],
): {
  added: BlockSnap[];
  removed: BlockSnap[];
  changed: Array<{ id: string; text: string; oldText: string }>;
} {
  const oldText = new Map(oldSnaps.map((s) => [s.id, s.text]));
  const newText = new Map(newSnaps.map((s) => [s.id, s.text]));
  const added = newSnaps.filter((s) => !oldText.has(s.id));
  const removed = oldSnaps.filter((s) => !newText.has(s.id));
  const changed = newSnaps
    .filter((s) => oldText.has(s.id) && oldText.get(s.id) !== s.text)
    .map((s) => ({ id: s.id, text: s.text, oldText: oldText.get(s.id) ?? "" }));
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
                return { id: b.id as string, text: typeof b.text === "string" ? b.text : "" };
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
