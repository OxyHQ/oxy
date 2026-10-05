import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
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
