/**
 * useOnlineStatus
 *
 * Reactive boolean reflecting TanStack Query's `onlineManager` state.
 * Mirrors browser `online`/`offline` events on web and NetInfo reachability
 * updates on native (both wired up in `OxyProvider`, aligned with Bloom's
 * `ConnectionStatusToasts` semantics).
 *
 * Use this for surfacing offline UI — an OfflineBanner, a disabled "Sync"
 * button, an inline "queued" badge on pending writes, etc. For pending /
 * paused mutation counts use `useMutationStatus()` instead.
 */

import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

const getOnlineSnapshot = (): boolean => onlineManager.isOnline();

const subscribeOnline = (notify: () => void): (() => void) => {
  return onlineManager.subscribe(() => {
    notify();
  });
};

// SSR: assume online so SSR-rendered markup doesn't show offline banners.
const getServerSnapshot = (): boolean => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getServerSnapshot);
}
