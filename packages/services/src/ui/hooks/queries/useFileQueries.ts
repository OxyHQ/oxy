/**
 * The person's file library and file access, read through `data/files.ts`
 * (`@oxy.so/bloom-data`). The screens edit the held listings with that
 * module's helpers (`prependUserFile`, `removeUserFile`, …) inside the tree's
 * store, so an answer for an account since left never reaches the next one.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  type RecordView,
  skip,
  useAction,
  useList,
  useRecord,
  useStore,
  withStore,
} from '@oxy.so/bloom-data';
import type { FileMetadata } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import {
  type FileAppAccessRecord,
  fileAppAccess,
  revokeFileAppAccess,
  UserFile,
  type UserFilesListing,
  userFiles,
} from '../../data/files';
import { useEntities } from '../../data/useEntities';

/** An owner's library or trash as a screen reads it. */
export interface UserFilesView {
  files: FileMetadata[];
  /** No page yet and the first is being read. */
  isLoading: boolean;
  /** The listing is being read again (pull to refresh, a reconcile) with files on screen. */
  isRefreshing: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  /** The last read failed after its retries. */
  isError: boolean;
  more: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * The owner's files, a page at a time: the LIBRARY (active files, and blocked
 * ones shown as removed after a claim) or, with `listing: 'trash'`, what the
 * owner moved to trash, most recently trashed first. Read when a screen opens
 * it and whenever `ownerId` changes; nothing is read until there is an owner.
 */
export function useUserFilesInfinite(
  ownerId?: string,
  listing: UserFilesListing = 'library',
): UserFilesView {
  const { oxyServices } = useOxy();
  const view = useList(
    userFiles,
    ...(ownerId ? ([oxyServices, ownerId, listing] as const) : ([skip] as const)),
  );
  const records = useEntities(UserFile, view.ids);
  const files = useMemo(
    () => records.filter((file): file is FileMetadata => file !== undefined),
    [records],
  );
  const [isFetchingMore, setFetchingMore] = useState(false);
  const { more: readMore, hasMore } = view;
  const more = useCallback(async () => {
    if (!hasMore) return;
    setFetchingMore(true);
    try {
      await readMore();
    } finally {
      setFetchingMore(false);
    }
  }, [hasMore, readMore]);
  return {
    files,
    isLoading: view.isLoading,
    isRefreshing: view.isFetching && !isFetchingMore && view.list !== undefined,
    isFetchingMore,
    hasMore,
    isError: view.status === 'error',
    more,
    refresh: view.refresh,
  };
}

/**
 * The applications that can open one of the owner's files with their own
 * token (ADR 0043 stage 4c). Read when `enabled` (the owner's own file), every
 * time the details open, since an application can gain access at any time.
 */
export function useFileAppAccess(fileId: string, enabled = true): RecordView<FileAppAccessRecord> {
  const { oxyServices } = useOxy();
  return useRecord(
    fileAppAccess,
    ...(enabled && fileId.length > 0 ? ([oxyServices, fileId] as const) : ([skip] as const)),
  );
}

/**
 * Take an application's access to one of the person's files away: the
 * application leaves the list at once and comes back if the revoke fails, then
 * the list is read again either way. The caller shows its own toasts (it
 * knows the application's name).
 */
export function useRevokeFileAppAccess() {
  const { oxyServices, activeSessionId } = useOxy();
  const store = useStore();
  const { run: revoke, isPending, error, reset } = useAction(revokeFileAppAccess);
  const run = useCallback(
    async ({ fileId, applicationId }: { fileId: string; applicationId: string }) => {
      try {
        return await revoke(oxyServices, activeSessionId, fileId, applicationId);
      } finally {
        void withStore(store, () => fileAppAccess.refresh(oxyServices, fileId));
      }
    },
    [revoke, oxyServices, activeSessionId, store],
  );
  return { run, isPending, error, reset };
}
