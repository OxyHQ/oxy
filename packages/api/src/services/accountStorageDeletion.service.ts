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
 * Every asset the account OWNS (`files.owner_user_id`), whatever its status.
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

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Transaction } from '../config/postgres';
import { stripPublicPrefix } from '../config/cdn';
import { appListingScreenshots } from '../db/schema/appListingScreenshots';
import { files } from '../db/schema/files';
import { fileVariants } from '../db/schema/fileVariants';
import { messageAttachments } from '../db/schema/messageAttachments';
import {
  storageObjectDeletions,
  type StorageObjectDeletionKind,
} from '../db/schema/storageObjectDeletions';

/** Rows per statement: large accounts are recorded in bounded chunks. */
const CHUNK_SIZE = 500;

/** `variants/<yyyy>/<mm>/<pp>/<sha256>/`, the directory `variantService.generateVariantKey` writes into. */
const VARIANT_DIRECTORY = /^variants\/\d{4}\/\d{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\/$/;

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
  asset: { sha256: string; storageKey: string },
  variantKeys: readonly string[],
): StorageDeletionTarget[] {
  const targets = new Map<string, StorageDeletionTarget>();
  const add = (kind: StorageObjectDeletionKind, target: string) => {
    targets.set(`${kind}:${target}`, { kind, target, sha256: asset.sha256 });
  };

  add('object', stripPublicPrefix(asset.storageKey));
  for (const key of variantKeys) {
    const base = stripPublicPrefix(key);
    const directory = base.slice(0, base.lastIndexOf('/') + 1);
    const match = VARIANT_DIRECTORY.exec(directory);
    if (match && match[1] === asset.sha256) {
      add('prefix', directory);
    } else {
      add('object', base);
    }
  }
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
export async function recordAccountStorageDeletion(
  tx: Transaction,
  accountId: string,
  options: { removeAssetRows: boolean },
): Promise<RecordedAccountStorageDeletion> {
  const owned = await tx
    .select({ id: files.id, sha256: files.sha256, storageKey: files.storageKey })
    .from(files)
    .where(and(
      eq(files.ownerUserId, accountId),
      notExists(
        tx.select({ one: sql`1` }).from(appListingScreenshots).where(eq(appListingScreenshots.fileId, files.id)),
      ),
      notExists(
        tx.select({ one: sql`1` }).from(messageAttachments).where(eq(messageAttachments.fileId, files.id)),
      ),
    ));

  if (owned.length === 0) return { fileIds: [], targets: 0 };

  const variantKeys = new Map<string, string[]>();
  for (const ids of chunks(owned.map((asset) => asset.id), CHUNK_SIZE)) {
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

  const targets = new Map<string, StorageDeletionTarget>();
  for (const asset of owned) {
    for (const target of storageTargetsForAsset(asset, variantKeys.get(asset.id) ?? [])) {
      targets.set(`${target.kind}:${target.target}`, target);
    }
  }

  for (const batch of chunks([...targets.values()], CHUNK_SIZE)) {
    await tx
      .insert(storageObjectDeletions)
      .values(batch.map((target) => ({ reason: 'account.deleted' as const, accountId, ...target })))
      .onConflictDoNothing();
  }

  const fileIds = owned.map((asset) => asset.id);
  if (options.removeAssetRows) {
    for (const ids of chunks(fileIds, CHUNK_SIZE)) {
      // Variants and links cascade with their asset.
      await tx.delete(files).where(inArray(files.id, ids));
    }
  }

  return { fileIds, targets: targets.size };
}
