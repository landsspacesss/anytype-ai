/**
 * A dependency-free 5-field cron matcher (minute hour dom month dow).
 *
 * Supported per-field syntax: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and
 * comma-separated lists of those. All matching is done in LOCAL time
 * (`date.getMinutes()` etc.), so callers must ensure the process runs in the
 * intended timezone (TZ=...).
 *
 * For day-of-month and day-of-week, standard cron OR-semantics apply: when BOTH
 * are restricted (not `*`), a day matches if EITHER field matches; when only one
 * is restricted, that one alone decides.
 */

/** Parsed fields. `dow` is normalised so Sunday is 0 (a `7` is folded to `0`). */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

const FIELD_RANGES: Array<[keyof ParsedCron, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 7],
];

/**
 * Parse one cron field (e.g. `1-5`, `*\/15`, `1,3,5`) into a set of numeric
 * values. `normalize` optionally folds a value (used to map dow 7 -> 0). Returns
 * null for anything malformed or out of range.
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  normalize?: (n: number) => number,
): Set<number> | null {
  const out = new Set<number>();
  const parts = raw.split(",");
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === "") return null;
    const slash = part.indexOf("/");
    const rangeStr = slash === -1 ? part : part.slice(0, slash);
    const stepStr = slash === -1 ? undefined : part.slice(slash + 1);
    if (rangeStr === "") return null;

    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number(stepStr);
      if (step < 1) return null;
    }

    let lo: number;
    let hi: number;
    if (rangeStr === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangeStr)) {
      lo = Number(rangeStr);
      hi = lo;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangeStr);
      if (!m) return null;
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) {
      out.add(normalize ? normalize(v) : v);
    }
  }
  return out;
}

/** Parse a 5-field cron expression. Returns null on anything invalid. */
export function parseCron(expr: string): ParsedCron | null {
  if (typeof expr !== "string") return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Partial<ParsedCron> = {};
  for (let i = 0; i < FIELD_RANGES.length; i++) {
    const [name, min, max] = FIELD_RANGES[i];
    const parsed = parseField(fields[i], min, max, name === "dow" ? (n) => (n === 7 ? 0 : n) : undefined);
    if (parsed === null) return null;
    sets[name] = parsed;
  }
  return sets as ParsedCron;
}

/**
 * True if `date` (LOCAL time) satisfies the 5-field cron expression. A
 * malformed expression returns false (never throws).
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minS, hourS, domS, monS, dowS] = fields;

  const min = parseField(minS, 0, 59);
  const hour = parseField(hourS, 0, 23);
  const dom = parseField(domS, 1, 31);
  const month = parseField(monS, 1, 12);
  const dow = parseField(dowS, 0, 7, (n) => (n === 7 ? 0 : n));
  if (!min || !hour || !dom || !month || !dow) return false;

  if (!min.has(date.getMinutes())) return false;
  if (!hour.has(date.getHours())) return false;
  if (!month.has(date.getMonth() + 1)) return false;

  const domStar = domS === "*";
  const dowStar = dowS === "*";
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());

  if (domStar && dowStar) return true;
  if (domStar) return dowHit;
  if (dowStar) return domHit;
  return domHit || dowHit;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A short Chinese description of the common cron forms, falling back to the raw
 * expression for anything else. Examples: `*\/30 * * * *` -> "每 30 分钟",
 * `0 9 * * *` -> "每天 09:00", `0 9 * * 1-5` -> "工作日 09:00".
 */
export function describeCron(expr: string): string {
  if (typeof expr !== "string") return String(expr);
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [minS, hourS, domS, monS, dowS] = fields;
  const hourStar = hourS === "*";
  const domStar = domS === "*";
  const monStar = monS === "*";
  const dowStar = dowS === "*";

  // Every minute.
  if (minS === "*" && hourStar && domStar && monStar && dowStar) return "每分钟";

  // Every n minutes.
  const every = /^\*\/(\d+)$/.exec(minS);
  if (every && hourStar && domStar && monStar && dowStar) return `每 ${every[1]} 分钟`;

  // Hourly (on the hour, or at a fixed minute).
  if (/^\d+$/.test(minS) && hourStar && domStar && monStar && dowStar) {
    return Number(minS) === 0 ? "每小时" : `每小时的第 ${Number(minS)} 分钟`;
  }

  // Daily / weekly at a fixed HH:MM.
  const minuteOk = /^\d+$/.test(minS) && Number(minS) <= 59;
  const hourOk = /^\d+$/.test(hourS) && Number(hourS) <= 23;
  if (minuteOk && hourOk && domStar && monStar) {
    const time = `${pad2(Number(hourS))}:${pad2(Number(minS))}`;
    if (dowStar) return `每天 ${time}`;
    if (dowS === "1-5") return `工作日 ${time}`;
    if (dowS === "0,6" || dowS === "6,0") return `周末 ${time}`;
    if (/^[0-7]$/.test(dowS)) {
      const day = WEEKDAYS[Number(dowS) === 7 ? 0 : Number(dowS)];
      return `每${day} ${time}`;
    }
  }

  return expr;
}
