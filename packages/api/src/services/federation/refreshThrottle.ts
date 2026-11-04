/**
 * When a stored external source is stale, and the storm guard that keeps one
 * background refresh or verification per actor at a time.
 */

/**
 * A cached federated record older than this is considered stale and triggers a
 * background refresh on the next resolve. The cached record is still returned
 * immediately — the refresh runs fire-and-forget. Bluesky-style: fast now,
 * eventually fresh.
 */
export const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum gap between background refresh attempts for the same actor. Guards
 * against refresh storms when many requests hit a stale record at once (each
 * request would otherwise schedule its own background fetch).
 */
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Actor URIs (or, when no actorUri is known yet, lowercased handles) currently
 * mid-refresh. Prevents two concurrent background refreshes of the same actor.
 */
const _refreshInFlight = new Set<string>();

/**
 * Last time a background refresh was *attempted* for a given key, used with
 * {@link REFRESH_MIN_INTERVAL_MS} to throttle repeated attempts.
 */
const _lastRefreshAttemptAt = new Map<string, number>();

/**
 * Take the background-work slot for `key`: false while a job for it is in
 * flight or one was attempted within {@link REFRESH_MIN_INTERVAL_MS}. The
 * caller releases it with {@link releaseRefreshSlot} when its job settles.
 */
export function claimRefreshSlot(key: string): boolean {
  if (_refreshInFlight.has(key)) return false;
  const lastAttempt = _lastRefreshAttemptAt.get(key);
  if (lastAttempt !== undefined && Date.now() - lastAttempt < REFRESH_MIN_INTERVAL_MS) {
    return false;
  }
  _refreshInFlight.add(key);
  _lastRefreshAttemptAt.set(key, Date.now());
  return true;
}

/** Release the slot {@link claimRefreshSlot} took. */
export function releaseRefreshSlot(key: string): void {
  _refreshInFlight.delete(key);
}
