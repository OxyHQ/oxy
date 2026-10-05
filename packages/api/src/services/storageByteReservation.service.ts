import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { storageByteReservations } from '../db/schema';
import { withContentHashLock } from './contentHashLock';
import { withStorageQuota } from './storageQuota.service';
import { ApiError } from '../utils/error';

/** A recovery lease, not a promised S3 request duration. Writers check under hash lock. */
const SERVER_RECOVERY_DELAY_MS = 5 * 60_000;
const RECOVERY_RETRY_DELAY_MS = 5 * 60_000;
export interface StorageByteReservationInput {
  accountId: string; sha256: string; objectKey: string; size: number;
  kind: 'server' | 'presigned'; recoverAfter?: Date;
}
export async function reserveStorageBytes(input: StorageByteReservationInput) {
  return withContentHashLock(input.sha256, tx => reserveStorageBytesWithinTransaction(tx, input));
}
/** Caller already holds this content hash lock; its transaction durably commits before PUT. */
export async function reserveStorageBytesWithinTransaction(tx: Transaction, input: StorageByteReservationInput) {
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new ApiError(400, 'Reservation size is invalid', 'STORAGE_INVALID_SIZE');
  return withStorageQuota(tx, [input.accountId], async () => {
    const [existing] = await tx.select().from(storageByteReservations).where(and(
      eq(storageByteReservations.accountId, input.accountId), eq(storageByteReservations.objectKey, input.objectKey))).for('update');
    if (existing) {
      if (existing.sha256 !== input.sha256 || existing.size !== input.size)
        throw new ApiError(409, 'Reservation attribution differs', 'STORAGE_RESERVATION_CONFLICT');
      if (input.kind === 'presigned') {
        const [renewed] = await tx.update(storageByteReservations).set({ kind: 'presigned', cleanedAt: null, retryAfter: null,
          recoverAfter: new Date(Math.max(existing.recoverAfter.getTime(), input.recoverAfter?.getTime() ?? Date.now() + SERVER_RECOVERY_DELAY_MS)) })
          .where(eq(storageByteReservations.id, existing.id)).returning();
        return renewed;
      }
      const [renewed] = await tx.update(storageByteReservations).set({ cleanedAt: null, retryAfter: null,
        recoverAfter: new Date(Math.max(existing.recoverAfter.getTime(), Date.now() + SERVER_RECOVERY_DELAY_MS)) })
        .where(eq(storageByteReservations.id, existing.id)).returning();
      return renewed; // never downgrade a presigned key to server-only recovery

    }
    const [row] = await tx.insert(storageByteReservations).values({ ...input,
      recoverAfter: input.recoverAfter ?? new Date(Date.now() + SERVER_RECOVERY_DELAY_MS) }).returning();
    return row;
  });
}
/** Must run through the writer's open hash-locked transaction before any PUT. */
export async function assertStorageReservationWritable(db: DatabaseOrTransaction, id: string) {
  const [row] = await db.select().from(storageByteReservations).where(eq(storageByteReservations.id, id)).for('update');
  if (!row || row.cleanedAt || row.recoverAfter.getTime() <= Date.now())
    throw new ApiError(409, 'Storage reservation expired before upload', 'STORAGE_RESERVATION_EXPIRED');
  return row;
}

/**
 * Caller owns the hash lock and this attempt's unique server key, and must prove
 * in its control flow that neither PUT nor a signed URL was ever issued.
 * This is not a general cleanup shortcut for interrupted uploads.
 */
export async function releaseUnwrittenStorageReservation(tx: Transaction, id: string): Promise<void> {
  const [current] = await tx.select().from(storageByteReservations).where(eq(storageByteReservations.id, id)).for('update');
  if (!current || current.cleanedAt) return;
  if (current.kind !== 'server')
    throw new ApiError(409, 'A presigned reservation requires terminal upload proof', 'STORAGE_RESERVATION_NOT_UNWRITTEN');
  await withStorageQuota(tx, [current.accountId], async () => {
    await tx.update(storageByteReservations).set({ cleanedAt: new Date() }).where(eq(storageByteReservations.id, id));
  });
}

/**
 * Bounded recovery entrypoint for the existing storage worker/scheduler.
 * Does no live/provider work unless its caller supplies an object-deletion adapter.
 * Presigned rows stay counted: signature expiry cannot bound in-flight PUTs.
 */
export async function recoverStorageByteReservations(
  deleteAndVerifyAbsent: (key: string) => Promise<void>,
  confirmUploadQuiescent: (reservation: typeof storageByteReservations.$inferSelect) => Promise<boolean>,
  limit = 25,
  now = new Date(),
): Promise<{ cleaned: number; retained: number; failed: number; backoffFailed: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid storage recovery batch limit');
  const candidates = await getDb().select().from(storageByteReservations)
    .where(and(isNull(storageByteReservations.cleanedAt), eq(storageByteReservations.kind, 'server'), lte(storageByteReservations.recoverAfter, now),
      or(isNull(storageByteReservations.retryAfter), lte(storageByteReservations.retryAfter, now)),
      // Referenced holds must not occupy every slot ahead of orphan recovery.
      // Recheck under the hash/account locks below: this is only candidate selection.
      sql`not exists (select 1 from "files" f where f.status in ('active', 'trash')
        and (f.storage_key = ${storageByteReservations.objectKey} or exists (
          select 1 from "file_variants" v where v.file_id = f.id and v.key = ${storageByteReservations.objectKey}
        )))`))
    .orderBy(storageByteReservations.recoverAfter, storageByteReservations.id).limit(limit);
  let cleaned = 0, retained = 0, failed = 0, backoffFailed = 0;
  const retryAfter = new Date(now.getTime() + RECOVERY_RETRY_DELAY_MS);
  for (const candidate of candidates) {
    try {
      const didClean = await withContentHashLock(candidate.sha256, async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`oxy:storage:account:${candidate.accountId}`}, 0))`);
        const [current] = await tx.select().from(storageByteReservations).where(eq(storageByteReservations.id, candidate.id)).for('update');
        if (!current || current.cleanedAt || current.kind !== 'server' || current.recoverAfter > now || (current.retryAfter && current.retryAfter > now)) return false;
        const claims = await tx.execute(sql`select 1 from "files" f where f.status in ('active', 'trash')
          and (f.storage_key = ${current.objectKey} or exists (
            select 1 from "file_variants" v where v.file_id = f.id and v.key = ${current.objectKey}
          )) limit 1`);
        if (claims.length) {
          await tx.update(storageByteReservations).set({ retryAfter }).where(eq(storageByteReservations.id, current.id));
          return false;
        }
        // Time/HEAD absence alone cannot prove a crashed request is finished.
        // The adapter must establish provider/proxy terminal completion first.
        if (!(await confirmUploadQuiescent(current))) {
          await tx.update(storageByteReservations).set({ retryAfter }).where(eq(storageByteReservations.id, current.id));
          return false;
        }
        // Failure/absence-verification failure leaves the durable claim counted.
        await deleteAndVerifyAbsent(current.objectKey);
        await tx.update(storageByteReservations).set({ cleanedAt: now }).where(eq(storageByteReservations.id, current.id));
        return true;
      });
      if (didClean) cleaned++; else retained++;
    } catch {
      // A failed candidate cannot abort later cleanup. Persist backoff after
      // its cleanup transaction rolled back; retain bytes and expose a count.
      failed++; retained++;
      try {
        await withContentHashLock(candidate.sha256, async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`oxy:storage:account:${candidate.accountId}`}, 0))`);
          await tx.update(storageByteReservations).set({ retryAfter }).where(and(
            eq(storageByteReservations.id, candidate.id), isNull(storageByteReservations.cleanedAt),
            eq(storageByteReservations.kind, 'server'), lte(storageByteReservations.recoverAfter, now)));
        });
      } catch { backoffFailed++; } // retain/report; do not abandon later candidates
    }
  }
  return { cleaned, retained, failed, backoffFailed };
}
