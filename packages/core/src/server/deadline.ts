/**
 * Waiting for a promise no longer than a deadline.
 *
 * For work that cannot be cancelled but may be ABANDONED: a DNS lookup, a
 * read-only fetch. The work keeps running after the deadline; only the wait
 * ends, so never put one around a write whose outcome the caller must know.
 *
 * Node-only, exported solely from `@oxy.so/core/server`.
 */

/** Limits for {@link withDeadline}. */
export interface DeadlineOptions {
  /** Longest wait, in milliseconds. */
  timeoutMs: number;
  /** Ends the wait early, as `aborted`, when it fires. */
  signal?: AbortSignal;
}

/** What waiting came to; a rejection of the work is rethrown, not wrapped. */
export type DeadlineResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Wait for `work` at most `timeoutMs` (and no longer than `signal` allows).
 * Settles exactly once; its timer and abort listener are removed on every
 * path, and a rejection of `work` after the deadline is absorbed.
 */
export function withDeadline<T>(
  work: Promise<T>,
  options: DeadlineOptions,
): Promise<DeadlineResult<T>> {
  const { timeoutMs, signal } = options;
  if (signal?.aborted) {
    work.catch(() => undefined);
    return Promise.resolve({ kind: 'aborted' });
  }
  return new Promise<DeadlineResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => resolve({ kind: 'aborted' }));
    const timer = setTimeout(() => finish(() => resolve({ kind: 'timeout' })), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve({ kind: 'ok', value })),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
