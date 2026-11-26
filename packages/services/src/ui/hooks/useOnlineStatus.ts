/**
 * useOnlineStatus
 *
 * Whether the device is online, as bloom-data's `environment` knows it: the
 * browser's own `online`/`offline` events on web, NetInfo reachability on
 * native (reported by `OxyProvider`, aligned with Bloom's
 * `ConnectionStatusToasts` semantics).
 *
 * Use this for surfacing offline UI — an OfflineBanner, a disabled "Sync"
 * button, an inline "queued" badge on pending writes, etc. For pending /
 * paused write counts use `useMutationStatus()` instead.
 */

import { useSyncExternalStore } from 'react';
import { environment } from '@oxy.so/bloom-data';

const getOnlineSnapshot = (): boolean => environment.online;

const subscribeOnline = (notify: () => void): (() => void) => environment.subscribe(notify);

// SSR: assume online so SSR-rendered markup doesn't show offline banners.
const getServerSnapshot = (): boolean => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getServerSnapshot);
}
