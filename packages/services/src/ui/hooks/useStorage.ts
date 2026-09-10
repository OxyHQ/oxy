import { useEffect, useRef, useState } from 'react';
import type { ApiError } from '@oxy.so/core';
import { createPlatformStorage, type StorageInterface } from '../utils/storageHelpers';

export interface UseStorageOptions {
  onError?: (error: ApiError) => void;
  logger?: (message: string, error?: unknown) => void;
}

export interface UseStorageResult {
  storage: StorageInterface | null;
  isReady: boolean;
}

/**
 * Simple React hook that initializes platform-appropriate storage.
 * Returns storage instance once ready, or null if initialization failed.
 */
export const useStorage = ({
  onError,
  logger,
}: UseStorageOptions = {}): UseStorageResult => {
  const [storage, setStorage] = useState<StorageInterface | null>(null);
  const initRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    // Prevent multiple initializations
    if (initRef.current) return;

    initRef.current = (async () => {
      try {
        const storageInstance = await createPlatformStorage();
        setStorage(storageInstance);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to initialize storage';
        if (logger) {
          logger(message, err);
        }
        onError?.({
          message,
          code: 'STORAGE_INIT_ERROR',
          status: 500,
        });
      }
    })();
  }, [logger, onError]);

  return {
    storage,
    isReady: storage !== null,
  };
};
