/**
 * Page-window resolution for a client-supplied `limit` / `offset` / `page`.
 *
 * ## Why this is shared, with the count
 *
 * An audit across the Oxy repos found SEVEN named pagination helpers in five
 * repos plus **46 inline clamps**, and no two agreeing on what a degenerate
 * input means. The disagreements are not theoretical; each of these is a real
 * behaviour in a shipped repo:
 *
 * - `?limit=abc` → the default, OR `NaN` reaching the query. `parseInt('abc',
 *   10)` is `NaN`, and `Math.max(1, NaN)` and `Math.min(50, NaN)` are BOTH
 *   `NaN`, so the classic `Math.min(max, Math.max(1, parseInt(x, 10)))` looks
 *   like it bounds the value and does not.
 * - `?limit=0` → the default, OR `1`.
 * - `?limit=5&limit=500` → `5`, OR `500`, OR `NaN`, OR `"5,500"` parsed as `5`.
 * - `?limit=5abc` → `5` (`parseInt`) OR a 400 (`Number`). Homiio's copy
 *   deliberately chose `Number` and says why: *"`parseInt('5abc')` is 5, which
 *   silently accepts a malformed value instead of reporting it."*
 * - absent → a page size, OR **everything in the table**.
 *
 * That last one is the reason this is a shared function rather than a style
 * note. Two Mention endpoints read an absent `limit` as "return every matching
 * row" and then hydrated relations for all of them; a response whose size is
 * decided by how much data the table happens to hold is not a page.
 *
 * ## The design: bounds are ARGUMENTS, not a registry
 *
 * A lane's page size belongs next to the lane. A table of numbers in here would
 * be a second place for them to live and a place for them to disagree — so this
 * takes `{ fallback, max }` and owns only the RULE. The rule is the part that
 * was being got wrong.
 */

export interface PageLimitBounds {
  /** Used when the caller supplies nothing usable. Never "unbounded". */
  fallback: number;
  /** Hard ceiling. A caller asking for more gets this. */
  max: number;
}

/**
 * Parse one query value to a finite integer, or `undefined`.
 *
 * Accepts the shapes an Express query string actually produces — a string, a
 * number, `undefined`, or an array when the parameter is repeated.
 *
 * **A repeated parameter takes the FIRST value.** The alternative is letting a
 * caller append a second parameter to escape a limit something upstream set for
 * it. (Note this is the opposite of the right answer for a parameter that
 * NARROWS what is served, where "supplied twice" must not read as "absent" —
 * `oxy`'s `singleQueryValue` handles that case and takes the last. The two are
 * different questions and deliberately have different answers.)
 *
 * Neither `parseInt` nor bare `Number`, and both rejections are measured:
 *
 * - `parseInt('5abc', 10)` is `5`, silently accepting a malformed value — the
 *   behaviour Homiio's copy switched away from for that reason.
 * - `Number('0x10')` is `16`. So is `Number('0b11')` → 3, `Number('0o17')` →
 *   15, `Number('1e3')` → 1000. A bare `Number` therefore accepts number
 *   FORMATS no query string should carry, and the first draft of this function
 *   did exactly that until a test caught `?limit=0x10` resolving to 16. None of
 *   those is unbounded or `NaN`, so nothing would have failed loudly — a
 *   caller would just have got a page size they did not ask for.
 *
 * So the string must be plain decimal digits with an optional sign, checked
 * before conversion. Surrounding whitespace is tolerated because a query string
 * can carry it without the caller's intent changing.
 */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

function integerFrom(raw: unknown): number | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === 'number') {
    return Number.isInteger(first) ? first : undefined;
  }
  if (typeof first !== 'string') return undefined;
  const trimmed = first.trim();
  if (!DECIMAL_INTEGER.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  // A run of digits long enough to exceed the safe range parses to a rounded
  // float, which is no longer the value the caller wrote.
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve a client-supplied page limit to a bounded positive integer.
 *
 * Every unusable input — missing, non-numeric, zero, negative, fractional,
 * `Infinity`, `NaN`, an empty string — collapses to `fallback`. That is the
 * guarantee: there is no input, malformed or hostile, that yields an unbounded
 * query or a `NaN`.
 */
export function resolvePageLimit(raw: unknown, bounds: PageLimitBounds): number {
  const parsed = integerFrom(raw);
  if (parsed === undefined || parsed < 1) return bounds.fallback;
  return Math.min(parsed, bounds.max);
}

/**
 * Resolve a non-negative offset.
 *
 * Separate from {@link resolvePageLimit} because the degenerate value differs:
 * an absent limit must become a page SIZE, while an absent offset is genuinely
 * zero. Folding them into one helper would need a sentinel to tell the two
 * apart, which is how "0 means unbounded" gets written.
 */
export function resolvePageOffset(raw: unknown): number {
  const parsed = integerFrom(raw);
  if (parsed === undefined || parsed < 0) return 0;
  return parsed;
}

/**
 * Resolve a 1-based `?page` to a positive integer.
 *
 * For the endpoints that page by number rather than by offset. `1` for anything
 * unusable, so `(page - 1) * limit` can never be negative or `NaN`.
 */
export function resolvePageNumber(raw: unknown): number {
  const parsed = integerFrom(raw);
  if (parsed === undefined || parsed < 1) return 1;
  return parsed;
}

/**
 * The offset a `?page` / `?limit` pair means.
 *
 * Exists because the multiplication is where the `NaN` used to land: a route
 * can resolve both parameters correctly and still compute
 * `(pageNum - 1) * limitNum` from values it never checked. Taking both through
 * this makes the arithmetic unreachable by hand.
 */
export function offsetForPage(rawPage: unknown, limit: number): number {
  return (resolvePageNumber(rawPage) - 1) * limit;
}
