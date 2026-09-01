import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { fileVariants, files } from '../db/schema';
import { resolveUserSubscriptionPlan } from '../utils/subscriptionPlan';
import type { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const STORAGE_CATEGORIES = ['documents', 'photosVideos', 'recordings', 'other'] as const;
type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

const getPlanStorageLimitBytes = (plan: string | undefined): number => {
  switch (plan) {
    case 'pro':
      return 2 * TB;
    case 'business':
      return 5 * TB;
    case 'basic':
    default:
      return 15 * GB;
  }
};

/**
 * Which bucket a file counts towards, from its MIME type.
 *
 * The Mongo original was a `$switch` over three `$regexMatch` branches with a
 * `default`; this is the same ladder as a `CASE`, in the same order (the order
 * matters — `application/` must not shadow `video/`). `~` is case-sensitive, as
 * `$regexMatch` was with these patterns.
 */
const CATEGORY = sql<StorageCategory>`case
  when ${files.mime} ~ '^(image|video)/' then 'photosVideos'
  when ${files.mime} ~ '^audio/' then 'recordings'
  when ${files.mime} ~ '^(text|application)/' then 'documents'
  else 'other'
end`;

/**
 * Bytes a file occupies INCLUDING its renditions.
 *
 * Mongo summed a nested array inside the same document
 * (`$add: ['$size', { $ifNull: [{ $sum: '$variants.size' }, 0] }]`); the
 * renditions are their own table now, so the inner sum is a correlated
 * subquery. `coalesce` reproduces `$ifNull` exactly: `sum` over no rows — or
 * over rows whose `size` is NULL, which a still-encoding rendition has — is
 * NULL, not 0, and `bigint + NULL` would make the whole file's contribution
 * vanish rather than count its original bytes.
 *
 * **The correlated reference is the dangerous part, and it was checked rather
 * than assumed.** A drizzle column interpolated into `sql` can render BARE when
 * its table is not in the statement's `FROM`, in which case
 * `where "file_id" = "id"` resolves BOTH names against `file_variants`, matches
 * nothing, and returns a plausible-looking total with the renditions silently
 * missing — no error (`CONVENTIONS.md`, "Trap, second guise"). Interpolating the
 * Column objects into a raw `sql` template with the outer `files` in scope
 * renders `"file_variants"."file_id" = "files"."id"`, fully qualified. The
 * behavioural guard is `__tests__/storage.controller.test.ts`, which adds a
 * rendition to an existing file and requires the total to MOVE.
 */
const TOTAL_BYTES = sql<string>`${files.size} + coalesce((
  select sum(${fileVariants.size})
  from ${fileVariants}
  where ${fileVariants.fileId} = ${files.id}
), 0)`;

export const getStorageUsage = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString() || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const subscriptionPlan = await resolveUserSubscriptionPlan(userId);
    const totalLimitBytes = getPlanStorageLimitBytes(subscriptionPlan);

    // `sum`/`count` over `bigint` come back as strings from postgres.js — a byte
    // total can exceed 2^53, so the driver refuses to guess. Parse once, here.
    const results = await getDb()
      .select({
        category: CATEGORY,
        bytes: sql<string>`sum(${TOTAL_BYTES})`,
        count: sql<string>`count(*)`,
      })
      .from(files)
      .where(and(eq(files.ownerUserId, userId), eq(files.status, 'active')))
      .groupBy(CATEGORY);

    const breakdown: Record<StorageCategory, { bytes: number; count: number }> = {
      documents: { bytes: 0, count: 0 },
      photosVideos: { bytes: 0, count: 0 },
      recordings: { bytes: 0, count: 0 },
      other: { bytes: 0, count: 0 },
    };

    for (const row of results) {
      breakdown[row.category] = { bytes: Number(row.bytes ?? 0), count: Number(row.count ?? 0) };
    }

    const totalUsedBytes =
      breakdown.documents.bytes +
      breakdown.photosVideos.bytes +
      breakdown.recordings.bytes +
      breakdown.other.bytes;

    return res.json({
      plan: subscriptionPlan,
      totalUsedBytes,
      totalLimitBytes,
      // Keep names close to UI categories; mail/family not implemented yet.
      categories: {
        documents: breakdown.documents,
        mail: { bytes: 0, count: 0 },
        photosVideos: breakdown.photosVideos,
        recordings: breakdown.recordings,
        family: { bytes: 0, count: 0 },
        other: breakdown.other,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error computing storage usage', error instanceof Error ? error : new Error(String(error)));
    return res.status(500).json({
      message: 'Error computing storage usage',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
