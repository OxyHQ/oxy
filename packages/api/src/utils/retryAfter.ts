/**
 * Read an upstream's `Retry-After` header (RFC 9110 §10.2.3): either a number
 * of seconds or an HTTP date. Returns the wait in milliseconds from `now`, or
 * `null` when the header is absent or unreadable — the caller decides its own
 * fallback and cap.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(date - now, 0);
}
