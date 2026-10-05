import { withContentHashLock } from './contentHashLock';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type DatabaseOrTransaction } from '../config/postgres';
import { randomUUID } from 'crypto';
import type { FileRecord, NewFileVariant } from '../types/file.types';
import { files, fileVariants } from '../db/schema';
import { FILE_LIVE_STATUSES } from '../db/schema/files';
import { resolveUserSubscriptionPlan } from '../utils/subscriptionPlan';
import { ApiError } from '../utils/error';
import { loadProductBillingCatalogue, type ProductBillingCatalogue } from './productBillingCatalogue.service';
import { readSubjectProductAccess } from './productAccessPersistence.service';

export function legacyStorageLimit(plan: string): number {
  return plan === 'business' ? 5 * 1024 ** 4 : plan === 'pro' ? 2 * 1024 ** 4 : 15 * 1024 ** 3;
}
export async function storageCapacity(db: DatabaseOrTransaction, userId: string, catalogue: ProductBillingCatalogue) {
  const legacy = legacyStorageLimit(await resolveUserSubscriptionPlan(userId, db));
  if (!catalogue.storageAdapter) return legacy;
  const adapter = catalogue.storageAdapter;
  const access = await readSubjectProductAccess(userId, adapter.productId, new Date(), db);
  if (access.conflicts.some(value => value.key === adapter.quotaKey))
    throw new ApiError(503, 'Storage entitlement configuration conflicts', 'STORAGE_ENTITLEMENT_CONFLICT');
  const quota = access.quotas.find(value => value.key === adapter.quotaKey);
  if (quota && quota.unit !== adapter.unit)
    throw new ApiError(503, 'Storage entitlement unit differs', 'STORAGE_ENTITLEMENT_CONFLICT');
  return Math.max(legacy, quota?.included ?? 0);
}
/** Live original reservations and known variants; trash retains its bytes. */
export async function reservedStorageBytes(db: DatabaseOrTransaction, userId: string): Promise<bigint> {
  const [row] = await db.select({ bytes: sql<string>`coalesce(sum(${files.size} + coalesce((
    select sum(${fileVariants.size}) from ${fileVariants} where "file_variants"."file_id" = "files"."id"
  ), 0)), 0)` }).from(files).where(and(eq(files.ownerUserId, userId), inArray(files.status, [...FILE_LIVE_STATUSES])));
  return BigInt(row?.bytes ?? 0);
}
/** Metadata admission only. Call inside the transaction that writes originals/variants. */
export async function withStorageQuota<T>(db: DatabaseOrTransaction, ownerIds: (string | null | undefined)[], write: () => Promise<T>): Promise<T> {
  const catalogue = await loadProductBillingCatalogue();
  if (!catalogue.storageAdapter) return write();
  const owners = [...new Set(ownerIds.filter((id): id is string => !!id))].sort();
  const before = new Map<string, { bytes: bigint; limit: bigint }>();
  for (const owner of owners) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`oxy:storage:account:${owner}`}, 0))`);
    before.set(owner, { bytes: await reservedStorageBytes(db, owner), limit: BigInt(await storageCapacity(db, owner, catalogue)) });
  }
  const result = await write();
  for (const owner of owners) {
    const usage = await reservedStorageBytes(db, owner);
    const previous = before.get(owner);
    if (!previous) throw new Error('Storage admission snapshot is missing');
    // Downgrades never block deletions, smaller replacements or metadata-only edits.
    if (usage > previous.limit && usage > previous.bytes)
      throw new ApiError(413, 'Storage quota exceeded', 'STORAGE_QUOTA_EXCEEDED');
  }
  return result;
}

/** Physical writers without complete byte admission fail closed when configured. */
export async function assertPhysicalStoragePathSupported(ownerUserId: string | null, path: string): Promise<void> {
  if (ownerUserId && (await loadProductBillingCatalogue()).storageAdapter)
    throw new ApiError(503, `Storage admission is unavailable for ${path}`, 'STORAGE_PHYSICAL_PATH_UNAVAILABLE');
}
/** Admit bounded output before PUT; hold account/file locks until its unique object is written. */
export async function uploadAdmittedVariant(file: FileRecord, variant: NewFileVariant,
  put: (key: string) => Promise<unknown>, remove: (key: string) => Promise<unknown>): Promise<NewFileVariant> {
  if (!file.ownerUserId || !(await loadProductBillingCatalogue()).storageAdapter) {
    await put(variant.key); return variant;
  }
  if (!Number.isSafeInteger(variant.size) || (variant.size ?? 0) < 0)
    throw new ApiError(400, 'Variant size is invalid', 'STORAGE_INVALID_SIZE');
  const admitted = { ...variant, key: `${variant.key}.${randomUUID()}` };
  let putStarted = false;
  try {
    return await withContentHashLock(file.sha256, async tx => {
      await withStorageQuota(tx, [file.ownerUserId], async () => {
        const [current] = await tx.select().from(files).where(eq(files.id, file.id)).for('update');
        if (!current || current.ownerUserId !== file.ownerUserId || !FILE_LIVE_STATUSES.includes(current.status as typeof FILE_LIVE_STATUSES[number]))
          throw new ApiError(409, 'File changed during variant admission', 'STORAGE_FILE_CHANGED');
        const existing = await tx.select().from(fileVariants).where(and(eq(fileVariants.fileId, file.id), eq(fileVariants.type, variant.type)));
        if (existing.length) throw new ApiError(409, 'Variant already exists; reuse its admitted object', 'STORAGE_VARIANT_EXISTS');
        await tx.insert(fileVariants).values({ ...admitted, fileId: file.id, readyAt: null });
      }); // enforce BEFORE PUT, rather than after bytes reach the bucket
      putStarted = true;
      await put(admitted.key);
      await tx.update(fileVariants).set({ readyAt: admitted.readyAt ?? new Date() }).where(and(eq(fileVariants.fileId, file.id), eq(fileVariants.key, admitted.key)));
      return admitted;
    });
  } catch (error) {
    if (putStarted) await remove(admitted.key);
    throw error;
  }
}
