/**
 * Global sync lock to prevent concurrent identity sync operations.
 */
let syncLock: AbortController | null = null;

export interface SyncLockResult {
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Release the lock */
  release: () => void;
}

/**
 * Acquire the global sync lock.
 * Throws if lock is already held.
 *
 * @returns Lock result with abort signal and release function
 * @throws Error if sync is already in progress
 */
export const acquireSyncLock = (): SyncLockResult => {
  if (syncLock) {
    throw new Error('Sync already in progress');
  }

  syncLock = new AbortController();

  return {
    signal: syncLock.signal,
    release: () => {
      if (syncLock) {
        syncLock.abort();
        syncLock = null;
      }
    },
  };
};

export const isSyncLocked = (): boolean => syncLock !== null;

export const releaseSyncLock = (): void => {
  if (syncLock) {
    syncLock.abort();
    syncLock = null;
  }
};

export const isSyncLockAborted = (error: unknown): boolean => {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.includes('aborted');
  }
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError',
  );
};
