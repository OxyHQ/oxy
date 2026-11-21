export interface NetInfoLikeState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/**
 * Whether the device is online, for bloom-data's `environment` (the one owner
 * of the signal; OxyProvider is its one feeder on a device). The rule is
 * NetInfo's `isConnected`: a network is there. NetInfo's reachability probe
 * (`isInternetReachable`) is deliberately ignored: it fetches a Google URL,
 * and on networks that block it the probe answers "unreachable" for good,
 * leaving every read and write paused on a working connection. An unknown
 * state (`null`, before NetInfo's first answer) counts as online, so nothing
 * waits on it.
 */
export function isNetConnectivityOnline(state: NetInfoLikeState): boolean {
  return state.isConnected !== false;
}
