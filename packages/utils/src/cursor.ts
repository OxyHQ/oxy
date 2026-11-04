/**
 * Return the next opaque cursor unless it is absent or has already been read.
 * Pass the page parameters for the current query, including the first page.
 * Callers remain responsible for their endpoint's has-more and error rules.
 */
export function nextUnvisitedCursor(
  next: string | null | undefined,
  visited: readonly (string | null | undefined)[],
): string | undefined {
  return next && !visited.includes(next) ? next : undefined;
}
