/**
 * Deleting an application deletes its files, now (ADR 0043 D8).
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
 *
 * ## Applications deleted before D8 existed
 *
 * An application deleted before this path shipped kept what it owned and the
 * references it held. The lifecycle sweep's `deletedApplications` step
 * (`fileLifecycle.worker.ts`) finds every `deleted` application that still has
 * either ({@link countDeletedApplicationsWithContent},
 * {@link listDeletedApplicationsWithContent}) and, in `enforce`, runs THIS path
 * on it ({@link purgeDeletedApplicationContent}) — the same transaction shape,
 * the same tombstones, ledger rows and `file.deleted` events. Idempotent: a
 * deleted application with nothing left matches nothing.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { applyPublicPrefix } from '../config/cdn';
import { type DatabaseOrTransaction, getDb, type Transaction } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { fileIngests } from '../db/schema/fileIngests';
import { filePlaySessions } from '../db/schema/filePlaySessions';
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
  /**
   * Files whose play sessions this application held were revoked (ADR 0042
   * stage 4c): their cached sessions are dropped on every task after commit.
   */
  playSessionFileIds: string[];
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
  // Stage 4c: the application's play sessions end now, and the large imports
  // and recording targets it created are expired — the upload worker aborts
  // them and deletes what they staged (a verifying one fails at finalization,
  // where `insertFile` refuses a deleted application's file).
  const revokedSessions = await tx
    .update(filePlaySessions)
    .set({ revokedAt: sql`now()`, revokedBy: 'oxy' })
    .where(
      and(eq(filePlaySessions.applicationId, applicationId), isNull(filePlaySessions.revokedAt)),
    )
    .returning({ fileId: filePlaySessions.fileId });
  await tx
    .update(fileIngests)
    .set({ expiresAt: sql`now()` })
    .where(
      and(
        eq(fileIngests.creatorApplicationId, applicationId),
        inArray(fileIngests.status, ['awaiting_upload', 'receiving']),
      ),
    );
  return {
    applicationId,
    referencesRemoved,
    playSessionFileIds: [...new Set(revokedSessions.map((row) => row.fileId))],
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

/** A `deleted` application that still owns live files or holds references. */
export interface DeletedApplicationResidue {
  applicationId: string;
  /** Its files that are not tombstoned (any of `active`, `trash`, `blocked`). */
  files: number;
  /** Their original bytes. */
  bytes: number;
  /** References it still holds, on any owner's file. */
  references: number;
  /** `applications.updated_at`: when the row last changed — normally its deletion. */
  since: Date | null;
}

/** Per application: what is left of it. Shared by the count and the list. */
const RESIDUE = sql`
  select a.id as application_id,
         a.updated_at as since,
         (select count(*) from files f
           where f.owner_application_id = a.id and f.status <> 'deleted') as files,
         (select coalesce(sum(f.size), 0) from files f
           where f.owner_application_id = a.id and f.status <> 'deleted') as bytes,
         (select count(*) from file_references r where r.application_id = a.id) as refs
    from applications a
   where a.status = 'deleted'
     and (exists (select 1 from files f
                   where f.owner_application_id = a.id and f.status <> 'deleted')
          or exists (select 1 from file_references r where r.application_id = a.id))`;

/** How many deleted applications still have content, and how much in all. */
export async function countDeletedApplicationsWithContent(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ applications: number; files: number; references: number }> {
  const [row] = await db.execute<{ applications: string; files: string; refs: string }>(sql`
    select count(*) as applications,
           coalesce(sum(residue.files), 0) as files,
           coalesce(sum(residue.refs), 0) as refs
      from (${RESIDUE}) residue`);
  // postgres.js decodes `count`/`sum` (int8/numeric) as strings.
  return {
    applications: Number(row?.applications ?? 0),
    files: Number(row?.files ?? 0),
    references: Number(row?.refs ?? 0),
  };
}

/** Up to `limit` of them, longest-deleted first. */
export async function listDeletedApplicationsWithContent(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<DeletedApplicationResidue[]> {
  const rows = await db.execute<{
    application_id: string;
    since: string | Date | null;
    files: string;
    bytes: string;
    refs: string;
  }>(sql`
    select * from (${RESIDUE}) residue
     order by residue.since asc nulls first, residue.application_id asc
     limit ${limit}`);
  return rows.map((row) => ({
    applicationId: row.application_id,
    files: Number(row.files),
    bytes: Number(row.bytes),
    references: Number(row.refs),
    since: row.since === null ? null : new Date(row.since),
  }));
}

/**
 * Run D8 on an application that is ALREADY `deleted` (see the module header):
 * under its row lock — the same lock order as the console's delete, so a
 * racing writer is refused exactly as there — re-check it is still `deleted`,
 * then {@link deleteApplicationContent}. `null` when it is not (an unknown id,
 * or an application that is not deleted: never touched). The caller hands a
 * result to `assetService.finishApplicationDeletion` after the commit.
 */
export async function purgeDeletedApplicationContent(
  applicationId: string,
): Promise<DeletedApplicationContent | null> {
  return getDb().transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .for('update');
    if (locked?.status !== 'deleted') return null;
    return deleteApplicationContent(tx, applicationId);
  });
}

/**
 * After the deletion committed: forget the tombstoned files and take every
 * public one off the CDN (its `public/` keys and the `/<id>` redirect
 * `GET /cdn/:id` answers). Never throws. The storage itself is owed in the
 * ledger, which the storage-deletion worker works off.
 */
export function invalidateDeletedApplicationFiles(content: DeletedApplicationContent): void {
  try {
    fileCache.invalidateMany([
      ...content.files.map((file) => file.id),
      ...content.playSessionFileIds,
    ]);
    const queue = getCdnInvalidationQueue();
    for (const file of content.files) {
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
