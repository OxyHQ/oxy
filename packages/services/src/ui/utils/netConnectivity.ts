export interface NetInfoLikeState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/**
 * Mirrors Bloom `ConnectionStatusToasts` reachability semantics: a link that
 * reports connected but explicitly unreachable (captive portal, no route) counts
 * as offline.
 */
export function isNetConnectivityOnline(state: NetInfoLikeState): boolean {
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

/**
 * Conservative offline verdict for boot-path probes. Unknown / probing states
 * (`null`, timed-out fetch) resolve to "not offline" so a flaky probe never
 * skips a real sign-in.
 */
export function isNetConnectivityExplicitlyOffline(
  state: NetInfoLikeState | null | undefined,
): boolean {
  if (!state) return false;
  if (state.isConnected === false) return true;
  if (state.isConnected === true && state.isInternetReachable === false) return true;
  return false;
}
