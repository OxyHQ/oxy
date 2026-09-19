/**
 * Small pure text helpers that were being copied between repos.
 *
 * The bar for anything here: byte-identical copies in three or more repos, and
 * a body short enough that no repo could reasonably want a different one. A
 * helper whose copies DISAGREE does not belong — that disagreement is usually a
 * product decision wearing a utility's clothes, and the audit that motivated
 * this package found several (compact number formatting reads `"1.2K"` in one
 * repo and `"482.8k"` in another; relative-time formatting differs by locale
 * support). Those stay where they are.
 */

/**
 * Escape a string for literal use inside a regular expression.
 *
 * Found SIXTEEN times across four repos — `oxy` (×6), `Mention` (×9), `Homiio`
 * (×4) — every one byte-identical, and in Mention's case nine copies coexisting
 * with an exported `escapeRegex` that none of them imported. That is the
 * signature of a helper nobody can find rather than one anybody disagrees with.
 *
 * `-` is NOT in the class, and that is deliberate: it is special only inside a
 * character class, and a caller interpolating this INTO one is already building
 * a pattern by hand and owns that. Escaping it would change nothing for the
 * ordinary case and imply a safety this does not provide.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clamp `value` into `[min, max]`, with `NaN` resolving to `min`.
 *
 * The `NaN` guard is the whole reason this is shared. `Math.min(max,
 * Math.max(min, NaN))` is `NaN`, so the idiomatic clamp does not clamp — and
 * the audit found exactly that split: two copies in `oxy` guard it, a third in
 * `Mention`'s feed ranking does not, so `clamp(NaN, 0, 1)` returned `NaN` there
 * and `0` in the other two. A score that silently becomes `NaN` propagates
 * through arithmetic without throwing.
 *
 * `min` rather than `max` for `NaN` because every caller found was clamping a
 * SCORE or a WEIGHT, where an unknown value must not outrank a known one.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Split `items` into consecutive chunks of at most `size`.
 *
 * Included for the batched-read pattern every backend has — `getUsersByIds`,
 * push delivery, an `inArray` over a list too long for one statement — where
 * the loop is written by hand 67 times across the ecosystem and the off-by-one
 * is silent when it happens.
 *
 * `size < 1` throws rather than looping forever, which is the failure a
 * computed size (`Math.floor(budget / cost)`) can produce.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, received ${String(size)}`);
  }
  if (items.length <= size) return items.length === 0 ? [] : [[...items]];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
