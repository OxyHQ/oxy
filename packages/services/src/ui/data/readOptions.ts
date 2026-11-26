import { retryAfterSecondsOf } from '@oxy.so/core';

const MAX_QUERY_RETRIES = 2;
/** The longest a query waits, silently, for a refusal's `Retry-After`; a longer wait is the person's to see. */
const MAX_RETRY_AFTER_MS = 30_000;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value =
    (error as { status?: unknown; response?: { status?: unknown } }).status ??
    (error as { response?: { status?: unknown } }).response?.status;
  return typeof value === 'number' ? value : null;
}

/** The wait a refusal asked for (`Retry-After`), in ms; 0 when it named none. */
function retryAfterMs(error: unknown): number {
  return (retryAfterSecondsOf(error) ?? 0) * 1000;
}

/**
 * How long to wait before the next attempt: what the refusal asked for
 * (`Retry-After` of a 429) when it named a wait, else exponential backoff.
 */
export function queryRetryDelay(attemptIndex: number, error: unknown): number {
  return retryAfterMs(error) || Math.min(1000 * 2 ** attemptIndex, 30_000);
}

/** Retry only failures that another attempt can plausibly change. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  const status = statusOf(error);
  // A refusal that asks for a longer wait than we hold a query for: retrying
  // sooner is refused again and spends the budget, so it fails now instead.
  if (retryAfterMs(error) > MAX_RETRY_AFTER_MS) return false;
  if (status === null) return true; // transport error without an HTTP response
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * The read options every SDK source shares, the ones its React Query client
 * gave every query: retry only what another attempt can change (transport
 * errors, 408, 425, 429, 5xx; at most twice; never past a long `Retry-After`),
 * back off as the refusal asked or exponentially, and do not re-read on focus
 * (mobile). bloom-data counts the first failure as 1, React Query as 0.
 *
 * `stale` stays per source: the `staleTime` its query had.
 */
export const sdkRead = {
  retry: (failureCount: number, error: unknown) => shouldRetryQuery(failureCount - 1, error),
  retryDelay: (failureCount: number, error: unknown) => queryRetryDelay(failureCount - 1, error),
  refetchOnFocus: false,
} as const;
