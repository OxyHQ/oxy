/**
 * The work half of `regenerate-lost-hls.ts`, split from the executable so a
 * test can import it without the script connecting to Postgres on load.
 */

import { and, asc, eq, gt, isNotNull, like, ne } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { fileVariants } from '../db/schema/fileVariants';
import { files } from '../db/schema/files';
import type { S3Service } from '../services/s3Service';
import { s3Service } from '../services/s3ServiceSingleton';
import { VariantService } from '../services/variantService';
import { logger } from '../utils/logger';

export interface RegenerateLostHlsResult {
  /** HLS playlists (master and renditions) checked. */
  playlists: number;
  /** Playlists whose object is gone. */
  lost: number;
  /** Live files naming at least one lost playlist. */
  files: number;
  /** Encodes run (or, on a dry run, that would be): one per content and spelling, shared with its twins. */
  regenerated: number;
  /** Files whose original is gone too: nothing left to encode from. */
  unrecoverable: number;
  /** Encodes that threw; a re-run retries them. */
  failed: number;
}

interface LostFile {
  fileId: string;
  sha256: string;
  storageKey: string;
  visibility: string;
}

/**
 * Find the live videos whose HLS playlists point at objects that no longer
 * exist, and encode them again from their originals.
 *
 * The files sharing one content and visibility spelling are twins naming the
 * SAME objects, so they are broken together and mended together: one encode
 * per group, which `generateVariants({ reencode })` hands to the rest.
 */
export async function regenerateLostHls(
  opts: {
    batchSize?: number;
    dryRun?: boolean;
    s3?: S3Service;
    regenerate?: (fileId: string) => Promise<void>;
  } = {},
): Promise<RegenerateLostHlsResult> {
  const batchSize = opts.batchSize ?? 200;
  const dryRun = opts.dryRun ?? false;
  const s3 = opts.s3 ?? s3Service;
  const regenerate =
    opts.regenerate ??
    ((fileId: string) => new VariantService(s3).generateVariants(fileId, { reencode: true }));
  const result: RegenerateLostHlsResult = {
    playlists: 0,
    lost: 0,
    files: 0,
    regenerated: 0,
    unrecoverable: 0,
    failed: 0,
  };

  const playlists = and(
    like(fileVariants.type, 'hls\\_%'),
    isNotNull(fileVariants.readyAt),
    ne(files.status, 'deleted'),
  );

  /** One entry per content and spelling; the first file found is the one encoded. */
  const groups = new Map<string, LostFile>();
  const lostFiles = new Set<string>();
  let lastId: string | null = null;
  for (;;) {
    const rows = await getDb()
      .select({
        id: fileVariants.id,
        key: fileVariants.key,
        fileId: files.id,
        sha256: files.sha256,
        storageKey: files.storageKey,
        visibility: files.visibility,
      })
      .from(fileVariants)
      .innerJoin(files, eq(files.id, fileVariants.fileId))
      .where(lastId ? and(playlists, gt(fileVariants.id, lastId)) : playlists)
      .orderBy(asc(fileVariants.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      result.playlists += 1;
      if (await s3.fileExists(row.key)) continue;
      result.lost += 1;
      lostFiles.add(row.fileId);
      const group = `${row.sha256}:${row.visibility === 'public' ? 'public' : 'private'}`;
      if (!groups.has(group)) groups.set(group, row);
    }

    logger.info('[regenerate-lost-hls] scan progress', {
      dryRun,
      ...result,
      files: lostFiles.size,
    });
    if (rows.length < batchSize) break;
  }
  result.files = lostFiles.size;

  for (const file of groups.values()) {
    if (!(await s3.fileExists(file.storageKey))) {
      result.unrecoverable += 1;
      logger.warn('[regenerate-lost-hls] original is gone too', {
        fileId: file.fileId,
        key: file.storageKey,
      });
      continue;
    }
    if (dryRun) {
      result.regenerated += 1;
      continue;
    }
    try {
      await regenerate(file.fileId);
      result.regenerated += 1;
      logger.info('[regenerate-lost-hls] regenerated', { fileId: file.fileId });
    } catch (error) {
      result.failed += 1;
      logger.warn('[regenerate-lost-hls] could not regenerate', {
        fileId: file.fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
