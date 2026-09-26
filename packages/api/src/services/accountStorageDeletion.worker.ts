/**
 * Deletes the S3 objects a deleted account's uploads occupied
 * (`storage_object_deletions`, OxyHQ/Mention#1178).
 *
 * At least once, and convergent. A row is claimed under a lease, its target is
 * deleted in BOTH spellings (the base key and its CDN `public/` copy), and the
 * row is completed. S3's DeleteObject answers success for a key that is already
 * gone, so a re-run after a crash, or a second task racing a lapsed lease,
 * deletes nothing twice and fails on nothing. A failure is retried with
 * exponential backoff (1 minute doubling, capped at 6 hours) and never
 * dead-lettered: giving up would leave the person's bytes stored with no record
 * that they are owed a delete.
 *
 * ## The shared-content guard
 *
 * Storage is content-addressed (`content/<y>/<m>/<pp>/<sha256>.<ext>`) and
 * upload dedup is global, so after the account's rows are gone somebody else can
 * upload the same bytes and be given the same key. Before deleting, the worker
 * asks whether a LIVE asset with that content still uses the target; if so the
 * row completes as `retained_shared` and nothing is deleted. The bytes kept are
 * then that other person's upload, not the deleted account's.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { applyPublicPrefix } from '../config/cdn';
import { getEnvBoolean, getEnvNumber } from '../config/env';
import { getDb, type Database } from '../config/postgres';
import { FILE_LIVE_STATUSES, files } from '../db/schema/files';
import { fileVariants } from '../db/schema/fileVariants';
import {
  storageObjectDeletions,
  type StorageObjectDeletionOutcome,
  type StorageObjectDeletionRow,
} from '../db/schema/storageObjectDeletions';
import { logger } from '../utils/logger';
import { s3Service } from './s3ServiceSingleton';

export const STORAGE_DELETION_LEASE_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Keys listed per page, and pages per prefix per attempt: 20,000 objects before a row yields. */
const LIST_PAGE_SIZE = 1000;
export const STORAGE_DELETION_MAX_LIST_ROUNDS = 20;
const MAX_RECORDED_ERROR_LENGTH = 500;

/** Delay before attempt `attempts + 1`, after `attempts` failures. */
export function storageDeletionBackoffMs(attempts: number): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20), MAX_BACKOFF_MS);
}

/** The object store, narrowed to what this worker does. S3's own delete is idempotent. */
export interface StorageDeletionStore {
  deleteObject(key: string): Promise<void>;
  listKeys(prefix: string, maxKeys: number): Promise<string[]>;
}

const defaultStore: StorageDeletionStore = {
  deleteObject: (key) => s3Service.deleteFile(key),
  listKeys: async (prefix, maxKeys) => (await s3Service.listFiles(prefix, maxKeys)).map((item) => item.key),
};

export interface StorageDeletionBatchOptions {
  ownerId: string;
  batchSize?: number;
  leaseMs?: number;
  store?: StorageDeletionStore;
  now?: () => Date;
}

export interface StorageDeletionBatchResult {
  claimed: number;
  deleted: number;
  retainedShared: number;
  failed: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

function claimableRows(db: Database, now: Date, claimedBefore: Date, limit: number) {
  return db
    .select({ id: storageObjectDeletions.id })
    .from(storageObjectDeletions)
    .where(and(
      isNull(storageObjectDeletions.completedAt),
      lte(storageObjectDeletions.nextAttemptAt, now),
      or(
        isNull(storageObjectDeletions.claimedAt),
        lt(storageObjectDeletions.claimedAt, claimedBefore),
      ),
    ))
    .orderBy(asc(storageObjectDeletions.nextAttemptAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

const LIVE_STATUSES = [...FILE_LIVE_STATUSES];
/** The key with any CDN `public/` prefix removed, in SQL. */
const baseKey = (column: typeof files.storageKey | typeof fileVariants.key) =>
  sql`regexp_replace(${column}, '^public/', '')`;

/**
 * Whether a LIVE asset with this content still uses the target. For an object,
 * its original or one of its renditions IS the key; for a variant directory,
 * any live asset with the content may be writing renditions into it.
 */
export async function isStorageTargetInUse(
  row: Pick<StorageObjectDeletionRow, 'kind' | 'target' | 'sha256'>,
): Promise<boolean> {
  const db = getDb();
  const live = and(eq(files.sha256, row.sha256), inArray(files.status, LIVE_STATUSES));

  if (row.kind === 'prefix') {
    const [hit] = await db.select({ id: files.id }).from(files).where(live).limit(1);
    return hit !== undefined;
  }

  const [asOriginal] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(live, sql`${baseKey(files.storageKey)} = ${row.target}`))
    .limit(1);
  if (asOriginal) return true;

  const [asVariant] = await db
    .select({ id: fileVariants.id })
    .from(fileVariants)
    .innerJoin(files, eq(files.id, fileVariants.fileId))
    .where(and(live, sql`${baseKey(fileVariants.key)} = ${row.target}`))
    .limit(1);
  return asVariant !== undefined;
}

/** Delete every key under a prefix, page by page. Throws when more remain after the round budget. */
async function deletePrefix(store: StorageDeletionStore, prefix: string): Promise<void> {
  for (let round = 0; round < STORAGE_DELETION_MAX_LIST_ROUNDS; round += 1) {
    const keys = await store.listKeys(prefix, LIST_PAGE_SIZE);
    if (keys.length === 0) return;
    for (const key of keys) {
      // A listing is bounded by the prefix; this is the belt to that brace.
      if (key.startsWith(prefix)) await store.deleteObject(key);
    }
  }
  if ((await store.listKeys(prefix, 1)).length > 0) {
    throw new Error(`Objects remain under ${prefix} after ${STORAGE_DELETION_MAX_LIST_ROUNDS} rounds; continuing next attempt`);
  }
}

async function deleteTarget(store: StorageDeletionStore, row: StorageObjectDeletionRow): Promise<void> {
  const spellings = [row.target, applyPublicPrefix(row.target)];
  for (const key of spellings) {
    if (row.kind === 'prefix') {
      await deletePrefix(store, key);
    } else {
      await store.deleteObject(key);
    }
  }
}

export async function runStorageDeletionBatch(
  options: StorageDeletionBatchOptions,
): Promise<StorageDeletionBatchResult> {
  const db = getDb();
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize
    ?? getEnvNumber('STORAGE_DELETION_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? STORAGE_DELETION_LEASE_MS;
  const claimTime = now();

  const claimed = await db
    .update(storageObjectDeletions)
    .set({ claimedAt: claimTime, claimedBy: options.ownerId })
    .where(inArray(
      storageObjectDeletions.id,
      claimableRows(db, claimTime, new Date(claimTime.getTime() - leaseMs), batchSize),
    ))
    .returning();

  const result: StorageDeletionBatchResult = { claimed: claimed.length, deleted: 0, retainedShared: 0, failed: 0 };
  if (claimed.length === 0) return result;

  const store = options.store ?? defaultStore;
  const ownedBy = (id: string) => and(
    eq(storageObjectDeletions.id, id),
    eq(storageObjectDeletions.claimedBy, options.ownerId),
    isNull(storageObjectDeletions.completedAt),
  );

  for (const row of claimed) {
    const attempts = row.attempts + 1;
    try {
      let outcome: StorageObjectDeletionOutcome = 'retained_shared';
      if (!(await isStorageTargetInUse(row))) {
        await deleteTarget(store, row);
        outcome = 'deleted';
      }
      const completed = await db.update(storageObjectDeletions).set({
        attempts,
        completedAt: now(),
        outcome,
        lastError: null,
      }).where(ownedBy(row.id)).returning({ id: storageObjectDeletions.id });
      if (completed.length === 1) {
        if (outcome === 'deleted') result.deleted += 1;
        else result.retainedShared += 1;
      }
    } catch (caught) {
      const error = describeError(caught);
      await db.update(storageObjectDeletions).set({
        attempts,
        lastError: error,
        claimedAt: null,
        claimedBy: null,
        nextAttemptAt: new Date(now().getTime() + storageDeletionBackoffMs(attempts)),
      }).where(ownedBy(row.id));
      result.failed += 1;
      // The target is a content-addressed key: no name, no account content.
      logger.warn('[StorageDeletion] Delete failed; will retry', {
        id: row.id,
        accountId: row.accountId,
        kind: row.kind,
        attempts,
        error,
      });
    }
  }

  return result;
}

/** Rows still owed a delete, for the health surface and tests. */
export async function countPendingStorageDeletions(accountId?: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(storageObjectDeletions)
    .where(and(
      isNull(storageObjectDeletions.completedAt),
      accountId === undefined ? undefined : eq(storageObjectDeletions.accountId, accountId),
    ));
  return row?.count ?? 0;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runStorageDeletionBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    logger.error(
      '[StorageDeletion] Batch failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * ON by default: a deleted person's files left in the bucket is the defect this
 * exists to fix. `STORAGE_DELETION_WORKER_ENABLED=false` pauses it; rows keep
 * accumulating and are worked off when it is switched back on.
 */
export function startStorageDeletionWorker(): boolean {
  if (!getEnvBoolean('STORAGE_DELETION_WORKER_ENABLED', true)) {
    logger.info('[StorageDeletion] Worker disabled; owed deletes accumulate until it is enabled');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('STORAGE_DELETION_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logger.info('[StorageDeletion] Worker started', { ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

export function stopStorageDeletionWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
