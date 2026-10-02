/**
 * Make an opaque identifier (e.g. a chat id) safe to use as a single path
 * segment: replace anything outside `[A-Za-z0-9._-]` with `_`, then cap the
 * length so a pathological id cannot blow past filesystem name limits.
 *
 * Ids we see in practice are base32-ish (`pqdthe`, `A7D1k…`) and pass through
 * unchanged; this is a guard for anything unexpected.
 */
export function sanitize(s: string, maxLen = 80): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
