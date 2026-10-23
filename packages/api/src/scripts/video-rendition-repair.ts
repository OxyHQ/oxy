import { and, asc, eq, like, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { files } from '../db/schema/files';
import { fileVariants } from '../db/schema/fileVariants';
import { VIDEO_RENDITION_PROFILE } from '../services/video-renditions';
import { VariantService } from '../services/variantService';
import { s3Service } from '../services/s3ServiceSingleton';
import type { S3Service } from '../services/s3Service';
import { logger } from '../utils/logger';

/** One bounded pass; a rerun selects only files still lacking the current complete set. */
export async function repairVideoRenditions(
  options: {
    dryRun?: boolean;
    limit?: number;
    fileId?: string;
    after?: string;
    s3?: S3Service;
    regenerate?: (fileId: string) => Promise<void>;
  } = {},
) {
  const dryRun = options.dryRun ?? true;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('limit must be 1–1000');
  if (options.after && !/^[0-9a-f]{64}:(public|private|unlisted)$/.test(options.after))
    throw new Error('Invalid repair cursor');
  const [afterHash, afterVisibility] = options.after?.split(':') ?? [];
  const s3 = options.s3 ?? s3Service;
  const regenerate =
    options.regenerate ??
    ((fileId: string) => new VariantService(s3).generateVariants(fileId, { reencode: true }));
  // One encode per content and visibility. No whole-corpus collection in memory.
  const candidates = await getDb()
    .selectDistinctOn([files.sha256, files.visibility], {
      id: files.id,
      sha256: files.sha256,
      visibility: files.visibility,
      storageKey: files.storageKey,
    })
    .from(files)
    .where(
      and(
        eq(files.status, 'active'),
        like(files.mime, 'video/%'),
        options.after
          ? sql`(${files.sha256}, ${files.visibility}) > (${afterHash}, ${afterVisibility})`
          : undefined,
        options.fileId ? eq(files.id, options.fileId) : undefined,
        sql`not exists (select 1 from ${fileVariants} where ${fileVariants.fileId} = ${files.id}
      and ${fileVariants.type} = 'hls_master' and ${fileVariants.readyAt} is not null
      and ${fileVariants.metadata}->>'encodingProfile' = ${VIDEO_RENDITION_PROFILE})`,
      ),
    )
    .orderBy(asc(files.sha256), asc(files.visibility), asc(files.id))
    .limit(limit);
  const result = {
    candidates: candidates.length,
    wouldRegenerate: 0,
    regenerated: 0,
    unrecoverable: 0,
    failed: 0,
    reachedLimit: candidates.length === limit,
    nextCursor: candidates.at(-1)
      ? `${candidates.at(-1)?.sha256}:${candidates.at(-1)?.visibility}`
      : undefined,
  };
  for (const file of candidates) {
    try {
      if (!(await s3.fileExists(file.storageKey))) {
        result.unrecoverable++;
        logger.warn('Video repair original is unavailable', {
          fileId: file.id,
          cursor: `${file.sha256}:${file.visibility}`,
        });
        continue;
      }
      if (dryRun) result.wouldRegenerate++;
      else {
        await regenerate(file.id);
        result.regenerated++;
      }
      logger.info('Video repair candidate', {
        fileId: file.id,
        visibility: file.visibility,
        dryRun,
        cursor: `${file.sha256}:${file.visibility}`,
      });
    } catch (error) {
      result.failed++;
      logger.error('Video rendition repair failed', {
        fileId: file.id,
        cursor: `${file.sha256}:${file.visibility}`,
        err: error,
      });
    }
  }
  return result;
}
