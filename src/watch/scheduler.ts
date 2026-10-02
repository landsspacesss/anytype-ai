import { cronMatches } from "./cron.js";
import { pollWatch, type PollDeps } from "./poller.js";

/**
 * Local minute key `YYYY-MM-DDTHH:MM`. Two Date objects in the same local minute
 * yield the same key, so it doubles as a "fired this minute" marker.
 */
export function minuteKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface SchedulerDeps extends PollDeps {
  /** Injectable clock for tests; defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Tick the scheduler: for each watch whose cron matches the current local
 * minute (and that has not already fired this minute), mark it fired and poll
 * it. The `lastFiredMinute` marker is persisted BEFORE polling so a crash
 * mid-poll cannot re-fire the same watch twice in one minute.
 *
 * Failures are isolated per record; one bad watch never stops the others.
 */
export async function pollDueWatches(deps: SchedulerDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const key = minuteKey(now);
  for (const rec of deps.store.all()) {
    try {
      if (!cronMatches(rec.cron, now)) continue;
      if (rec.lastFiredMinute === key) continue; // already fired this minute
      rec.lastFiredMinute = key;
      deps.store.save();
      await pollWatch(rec, deps);
    } catch (err) {
      console.warn(`pollDueWatches: watch ${rec.objectId} failed: ${String(err)}`);
    }
  }
}
