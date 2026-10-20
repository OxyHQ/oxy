/**
 * Map `items` through `fn` with at most `limit` calls in flight, answering the
 * results in the order of `items` whatever order the calls finish in.
 *
 * Items are STARTED in order, so a caller that reads the calls of a stub sees
 * them in input order too.
 *
 * On the first rejection no further item is started, every call already in
 * flight is awaited, and then that first error is thrown. Waiting is the
 * point: a caller cleaning up after a failure (the files an inbound delivery
 * uploaded, say) must see every side effect the batch made, not only those
 * that happened to finish before the error.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // An array rather than a `let`: TypeScript does not see a closure assign a
  // `let`, and would read the check below as unreachable.
  const failures: unknown[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  const workers = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failures.length > 0) throw failures[0];
  return results;
}
