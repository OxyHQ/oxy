/**
 * useMutationStatus
 *
 * What the signed-in account's writes are doing (bloom-data's
 * `useActionStatus`): how many run now and how many wait for the network.
 * Useful for showing a global "Syncing..." indicator in the app shell.
 */

import { useMemo } from 'react';
import { useActionStatus } from '@oxy.so/bloom-data';

export interface MutationStatus {
  /** Writes running now. */
  pending: number;
  /** Writes waiting for the network to come back. */
  paused: number;
  /** `pending + paused`. */
  total: number;
  /** True if any write is waiting for connectivity. */
  isOffline: boolean;
  /** True if any write is running or waiting to sync. */
  isSyncing: boolean;
}

export function useMutationStatus(): MutationStatus {
  const { pending, paused } = useActionStatus();
  return useMemo(
    () => ({
      pending,
      paused,
      total: pending + paused,
      isOffline: paused > 0,
      isSyncing: pending > 0 || paused > 0,
    }),
    [pending, paused],
  );
}
