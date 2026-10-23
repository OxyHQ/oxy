/**
 * Recording what storage a deleted account's uploads occupy, so the objects
 * can be deleted after the rows are gone (OxyHQ/Mention#1178).
 *
 * Called inside the transaction that deletes or archives the account — see
 * `db/schema/storageObjectDeletions.ts` for why, and
 * `accountStorageDeletion.worker.ts` for the half that touches S3.
 *
 * ## Which assets
 *
 * Every asset the account OWNS (`files.owner_user_id`), whatever its status,
 * and every asset owned by an APPLICATION the account owns
 * (`files.owner_application_id`, ADR 0043). The second set is removed even on
 * a hard delete, where the account's own rows cascade: the `users` cascade
 * deletes the applications, and `files.owner_application_id` is `RESTRICT`
 * precisely so those rows can never vanish without their storage being
 * recorded — they must be gone before the cascade reaches the applications.
 * System-owned assets are never touched: the federation avatar and remote-media
 * caches (`files.system_owner`) are keyed by a remote URL, not by a local
 * account, and no account's deletion can reach them.
 *
 * Two kinds of owned asset are left alone, because a LIVE record other than the
 * account still points at them and a foreign key forbids removing the row:
 * a screenshot of an app listing (`app_listing_screenshots`, `RESTRICT`) and an
 * attachment on a message in somebody else's mailbox (`message_attachments`,
 * `no action`). On a hard delete those references already refuse the whole
 * deletion (pre-existing behaviour); on an archive they are kept with the
 * record that uses them, so the archive does not fail on them.
 */

import { and, eq, inArray, notExists, or, sql } from 'drizzle-orm';
import type { Transaction } from '../config/postgres';
import { stripPublicPrefix } from '../config/cdn';
import { variantStorageRoot, videoStorageRoots } from '../utils/variant-storage-roots';
import { appListingScreenshots } from '../db/schema/appListingScreenshots';
import { applications } from '../db/schema/applications';
import { files } from '../db/schema/files';
import { fileVariants } from '../db/schema/fileVariants';
import { messageAttachments } from '../db/schema/messageAttachments';
import { recordFileEvents } from './fileEvents.service';
import {
  storageObjectDeletions,
  type StorageObjectDeletionKind,
} from '../db/schema/storageObjectDeletions';

/** Rows per statement: large accounts are recorded in bounded chunks. */
const CHUNK_SIZE = 500;

export interface StorageDeletionTarget {
  kind: StorageObjectDeletionKind;
  target: string;
  sha256: string;
}

export interface RecordedAccountStorageDeletion {
  /** The assets whose storage is now owed a delete. */
  fileIds: string[];
  /** Deletion targets recorded (objects plus variant directories). */
  targets: number;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * The storage targets of one asset: its original, and the directory holding its
 * renditions. A variant directory is deleted as a PREFIX because it also holds
 * the HLS segments a video's playlists name, which no `file_variants` row lists.
 * A variant key outside the known directory shape falls back to the key itself,
 * so a directory is only ever deleted when it provably belongs to this content.
 */
export function storageTargetsForAsset(
  asset: { sha256: string; storageKey: string; metadata?: Record<string, unknown> | null },
  variantKeys: readonly string[],
): StorageDeletionTarget[] {
  const targets = new Map<string, StorageDeletionTarget>();
  const add = (kind: StorageObjectDeletionKind, target: string) => {
    targets.set(`${kind}:${target}`, { kind, target, sha256: asset.sha256 });
  };

  add('object', stripPublicPrefix(asset.storageKey));
  for (const key of variantKeys) {
    const base = stripPublicPrefix(key);
    const root = variantStorageRoot(base, asset.sha256);
    if (root) {
      add('prefix', root);
    } else {
      add('object', base);
    }
  }
  for (const root of videoStorageRoots(asset)) add('prefix', root);
  return [...targets.values()];
}

/**
 * Record the storage deletes a deleted account's uploads are owed, inside the
 * deletion's own transaction. With `removeAssetRows` (the archive path, where
 * the account row and therefore the cascade survive) the asset rows are deleted
 * here too; on a hard delete the `users` cascade removes them.
 *
 * Idempotent: a target already recorded for this account is not recorded twice.
 */
/**
 * Record the storage ONE tombstoned asset is owed, inside the tombstone's own
 * transaction, and return the ledger row ids so the caller can work them off
 * immediately (the worker picks up anything that fails).
 *
 * A target recorded before — the same content deleted, re-uploaded and deleted
 * again — is re-armed rather than skipped: the earlier row may be complete, and
 * this deletion still owes the objects.
 */
export async function recordFileStorageDeletion(
  tx: Transaction,
  asset: {
    sha256: string;
    metadata?: Record<string, unknown> | null;
    storageKey: string;
    ownerUserId: string | null;
    systemOwner: string | null;
    ownerApplicationId: string | null;
  },
  variantKeys: readonly string[],
): Promise<string[]> {
  return armStorageTargets(
    tx,
    'file.deleted',
    assetAccountId(asset),
    storageTargetsForAsset(asset, variantKeys),
  );
}

/**
 * Record the storage MANY tombstoned assets are owed, inside their tombstone's
 * transaction — {@link recordFileStorageDeletion} for a batch (an
 * application's deletion tombstones every file it owns, ADR 0043 D8). Same
 * reason, same ledger owner per asset, same re-arming. Returns the ledger ids.
 */
export async function recordFilesStorageDeletion(
  tx: Transaction,
  assets: ReadonlyArray<{
    sha256: string;
    metadata?: Record<string, unknown> | null;
    storageKey: string;
    ownerUserId: string | null;
    systemOwner: string | null;
    ownerApplicationId: string | null;
    variantKeys: readonly string[];
  }>,
): Promise<string[]> {
  const byAccount = new Map<string, Map<string, StorageDeletionTarget>>();
  for (const asset of assets) {
    const accountId = assetAccountId(asset);
    const targets = byAccount.get(accountId) ?? new Map<string, StorageDeletionTarget>();
    for (const target of storageTargetsForAsset(asset, asset.variantKeys)) {
      targets.set(`${target.kind}:${target.target}`, target);
    }
    byAccount.set(accountId, targets);
  }
  const ids: string[] = [];
  for (const [accountId, targets] of byAccount) {
    for (const batch of chunks([...targets.values()], CHUNK_SIZE)) {
      ids.push(...(await armStorageTargets(tx, 'file.deleted', accountId, batch)));
    }
  }
  return ids;
}

/**
 * Record the keys ONE asset stopped using when a visibility change copied its
 * objects to the other spelling (`public/` or not), inside the transaction that
 * repointed the row. Keys are object targets; videos also owe every recorded
 * generation root so superseded public copies and unlisted segments cannot
 * outlive a visibility downgrade. The worker's content lock and per-spelling
 * live-owner check preserve roots another public/private owner still needs.
 */
export async function recordFileStorageRelocation(
  tx: Transaction,
  asset: {
    sha256: string;
    metadata?: Record<string, unknown> | null;
    ownerUserId: string | null;
    systemOwner: string | null;
    ownerApplicationId: string | null;
  },
  oldKeys: readonly string[],
): Promise<string[]> {
  const roots = videoStorageRoots(asset);
  if (oldKeys.length === 0 && roots.length === 0) return [];
  const targets = new Map<string, StorageDeletionTarget>();
  for (const key of oldKeys) {
    const target = stripPublicPrefix(key);
    targets.set(target, { kind: 'object', target, sha256: asset.sha256 });
  }
  for (const root of roots)
    targets.set(`prefix:${root}`, { kind: 'prefix', target: root, sha256: asset.sha256 });
  return armStorageTargets(tx, 'file.relocated', assetAccountId(asset), [...targets.values()]);
}

/**
 * The ledger's `account_id` for one asset: its owning account, `app:<id>` for
 * an application-owned asset (ADR 0043), or `system:<namespace>`. Never a
 * foreign key (`storageObjectDeletions.ts`), so each owner kind gets its own
 * prefix and two kinds can never collide on one target.
 */
export function assetAccountId(asset: {
  ownerUserId: string | null;
  systemOwner: string | null;
  ownerApplicationId: string | null;
}): string {
  if (asset.ownerUserId) return asset.ownerUserId;
  if (asset.ownerApplicationId) return `app:${asset.ownerApplicationId}`;
  return `system:${asset.systemOwner ?? 'unknown'}`;
}

async function armStorageTargets(
  tx: Transaction,
  reason: 'file.deleted' | 'file.relocated',
  accountId: string,
  targets: readonly StorageDeletionTarget[],
): Promise<string[]> {
  const rows = await tx
    .insert(storageObjectDeletions)
    .values(targets.map((target) => ({ reason, accountId, ...target })))
    .onConflictDoUpdate({
      target: [
        storageObjectDeletions.accountId,
        storageObjectDeletions.kind,
        storageObjectDeletions.target,
      ],
      set: {
        reason: sql`excluded.reason`,
        sha256: sql`excluded.sha256`,
        attempts: 0,
        nextAttemptAt: sql`now()`,
        claimedAt: null,
        claimedBy: null,
        completedAt: null,
        outcome: null,
        lastError: null,
      },
    })
    .returning({ id: storageObjectDeletions.id });
  return rows.map((row) => row.id);
}

export async function recordAccountStorageDeletion(
  tx: Transaction,
  accountId: string,
  options: { removeAssetRows: boolean },
): Promise<RecordedAccountStorageDeletion> {
  const owned = await tx
    .select({
      id: files.id,
      sha256: files.sha256,
      storageKey: files.storageKey,
      metadata: files.metadata,
      ownerUserId: files.ownerUserId,
      ownerApplicationId: files.ownerApplicationId,
      status: files.status,
    })
    .from(files)
    .where(
      and(
        or(
          eq(files.ownerUserId, accountId),
          inArray(
            files.ownerApplicationId,
            tx
              .select({ id: applications.id })
              .from(applications)
              .where(eq(applications.ownerAccountId, accountId)),
          ),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(appListingScreenshots)
            .where(eq(appListingScreenshots.fileId, files.id)),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(messageAttachments)
            .where(eq(messageAttachments.fileId, files.id)),
        ),
      ),
    );

  if (owned.length === 0) return { fileIds: [], targets: 0 };

  const variantKeys = new Map<string, string[]>();
  for (const ids of chunks(
    owned.map((asset) => asset.id),
    CHUNK_SIZE,
  )) {
    const rows = await tx
      .select({ fileId: fileVariants.fileId, key: fileVariants.key })
      .from(fileVariants)
      .where(inArray(fileVariants.fileId, ids));
    for (const row of rows) {
      const keys = variantKeys.get(row.fileId) ?? [];
      keys.push(row.key);
      variantKeys.set(row.fileId, keys);
    }
  }

  // Keyed by ledger owner too: an application's asset is recorded under
  // `app:<id>`, exactly as its own per-file delete would record it.
  const targets = new Map<string, StorageDeletionTarget & { accountId: string }>();
  for (const asset of owned) {
    const ledgerAccountId = asset.ownerApplicationId
      ? `app:${asset.ownerApplicationId}`
      : accountId;
    for (const target of storageTargetsForAsset(asset, variantKeys.get(asset.id) ?? [])) {
      targets.set(`${ledgerAccountId}:${target.kind}:${target.target}`, {
        ...target,
        accountId: ledgerAccountId,
      });
    }
  }

  for (const batch of chunks([...targets.values()], CHUNK_SIZE)) {
    await tx
      .insert(storageObjectDeletions)
      .values(batch.map((target) => ({ reason: 'account.deleted' as const, ...target })))
      .onConflictDoNothing();
  }

  const fileIds = owned.map((asset) => asset.id);

  // Every application using one of the ACCOUNT's own files is told it is gone
  // (ADR 0043 D9), in this transaction and while the rows and their references
  // still stand: the archive removes them below, the hard delete's `users`
  // cascade after. The account's applications' files were tombstoned — and
  // their users told — by `deleteAccountApplications` just before; a file
  // tombstoned earlier was announced then.
  await recordFileEvents(
    tx,
    'file.deleted',
    owned
      .filter((asset) => asset.ownerUserId === accountId && asset.status !== 'deleted')
      .map((asset) => asset.id),
    { status: 'deleted' },
  );

  // An application's rows go on EVERY path: no cascade reaches them
  // (`RESTRICT`), and on a hard delete they must be gone before the `users`
  // cascade deletes their application.
  const removable = options.removeAssetRows
    ? fileIds
    : owned.filter((asset) => asset.ownerApplicationId !== null).map((asset) => asset.id);
  for (const ids of chunks(removable, CHUNK_SIZE)) {
    // Variants and links cascade with their asset.
    await tx.delete(files).where(inArray(files.id, ids));
  }

  return { fileIds, targets: targets.size };
}
