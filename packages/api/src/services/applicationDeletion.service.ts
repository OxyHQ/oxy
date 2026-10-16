/**
 * Deleting an application deletes its files, now (ADR 0041 D8).
 *
 * {@link deleteApplicationContent} runs INSIDE the transaction that marks the
 * application `deleted` — the console's delete (`DELETE /applications/:appId`)
 * and an account's deletion or archive, which deletes the account's
 * applications first ({@link deleteAccountApplications}). In that one commit:
 *
 *  - every reference the application registered is removed; an account's file
 *    it used only becomes *not in use* for its owner (never trashed);
 *  - every file the application owns is tombstoned — no 30-day trash, the
 *    developer asked for deletion — and owed its purge in
 *    `storage_object_deletions` (`file.deleted`, ledger owner `app:<id>`), so a
 *    tombstone never exists without its purge, exactly as a single delete;
 *  - every OTHER application using one of those files is told `file.deleted`
 *    (D9). The deleted application itself is told nothing.
 *
 * After the commit the caller hands the result to
 * {@link invalidateDeletedApplicationFiles} (the console route goes through
 * `assetService.finishApplicationDeletion`, which also starts working the
 * ledger off at once); whatever is not drained right away, the storage-deletion
 * worker does. The soft-deleted `applications` row stays as
 * the audit record; nothing of the application's content remains.
 */

import { and, eq, ne } from 'drizzle-orm';
import { applyPublicPrefix } from '../config/cdn';
import type { Transaction } from '../config/postgres';
import { applications } from '../db/schema/applications';
import fileCache from '../utils/fileCache';
import { logger } from '../utils/logger';
import { recordFilesStorageDeletion } from './accountStorageDeletion.service';
import { getCdnInvalidationQueue } from './cdnInvalidation';
import { recordFileEvents } from './fileEvents.service';
import { deleteApplicationReferences, tombstoneApplicationFiles } from './fileRepository';

/** What an application's deletion did, for the post-commit cleanup and the audit log. */
export interface DeletedApplicationContent {
  applicationId: string;
  referencesRemoved: number;
  /** The tombstoned files, as the post-commit cleanup needs them. */
  files: Array<{
    id: string;
    visibility: string;
    storageKey: string;
    variantKeys: string[];
  }>;
  /** `storage_object_deletions` rows armed, to work off right away. */
  ledgerIds: string[];
}

/**
 * Remove the application's references and tombstone its files inside `tx`
 * (see the module header). The caller has locked the application row and set
 * it `deleted` in the same transaction, so no event is queued for it and no
 * new reference or upload can be admitted for it.
 */
export async function deleteApplicationContent(
  tx: Transaction,
  applicationId: string,
): Promise<DeletedApplicationContent> {
  const referencesRemoved = await deleteApplicationReferences(tx, applicationId);
  const tombstoned = await tombstoneApplicationFiles(tx, applicationId);
  const ledgerIds = await recordFilesStorageDeletion(
    tx,
    tombstoned.map((file) => ({
      ...file,
      variantKeys: file.variants.map((variant) => variant.key),
    })),
  );
  await recordFileEvents(
    tx,
    'file.deleted',
    tombstoned.map((file) => file.id),
  );
  return {
    applicationId,
    referencesRemoved,
    files: tombstoned.map((file) => ({
      id: file.id,
      visibility: file.visibility,
      storageKey: file.storageKey,
      variantKeys: file.variants.map((variant) => variant.key),
    })),
    ledgerIds,
  };
}

/**
 * Delete every application `accountId` owns, the same way, inside the
 * account's deletion or archive transaction — BEFORE the account's own storage
 * is recorded (`recordAccountStorageDeletion`), which then removes the
 * tombstoned rows so the `users` cascade can never be blocked by
 * `files.owner_application_id`'s `RESTRICT`.
 */
export async function deleteAccountApplications(
  tx: Transaction,
  accountId: string,
): Promise<DeletedApplicationContent[]> {
  const owned = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.ownerAccountId, accountId), ne(applications.status, 'deleted')))
    .orderBy(applications.id)
    .for('update');
  const deleted: DeletedApplicationContent[] = [];
  for (const application of owned) {
    await tx
      .update(applications)
      .set({ status: 'deleted' })
      .where(eq(applications.id, application.id));
    deleted.push(await deleteApplicationContent(tx, application.id));
  }
  return deleted;
}

/**
 * After the deletion committed: forget the tombstoned files and take every
 * public one off the CDN (its `public/` keys and the `/<id>` redirect
 * `GET /cdn/:id` answers). Never throws. The storage itself is owed in the
 * ledger, which the storage-deletion worker works off.
 */
export function invalidateDeletedApplicationFiles(content: DeletedApplicationContent): void {
  try {
    const queue = getCdnInvalidationQueue();
    for (const file of content.files) {
      fileCache.invalidate(file.id);
      if (file.visibility !== 'public') continue;
      for (const key of [file.storageKey, ...file.variantKeys]) {
        queue.enqueueDeletedKey(applyPublicPrefix(key));
      }
      queue.enqueuePath(`/${file.id}`);
    }
  } catch (error) {
    logger.error('Deleted application: CDN invalidation could not be queued', {
      applicationId: content.applicationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
