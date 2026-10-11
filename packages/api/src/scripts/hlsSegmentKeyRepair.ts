/**
 * The repair half of `repair-hls-segment-keys.ts`, split from the executable so
 * a test can import it without the script connecting to Postgres on load.
 */

import { and, asc, gt, isNotNull, like, ne } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { fileVariants } from '../db/schema/fileVariants';
import type { S3Service } from '../services/s3Service';
import { s3Service } from '../services/s3ServiceSingleton';
import { legacySegmentKeys, playlistSiblingKey, playlistUris } from '../services/hlsPlaylist';
import { logger } from '../utils/logger';

export interface RepairHlsSegmentsResult {
  /** Rendition playlists read. */
  playlists: number;
  /** Segments copied (or, on a dry run, that would be) to the name the playlist lists. */
  repaired: number;
  /** Segments already stored where their playlist points. */
  alreadyCorrect: number;
  /** Segments with neither the listed nor a legacy object: unrecoverable here. */
  missing: number;
  /** Playlists that could not be read or repaired; a re-run retries them. */
  failed: number;
}

export async function repairHlsSegmentKeys(
  opts: { batchSize?: number; dryRun?: boolean; s3?: S3Service } = {},
): Promise<RepairHlsSegmentsResult> {
  const batchSize = opts.batchSize ?? 200;
  const dryRun = opts.dryRun ?? false;
  const s3 = opts.s3 ?? s3Service;
  const result: RepairHlsSegmentsResult = {
    playlists: 0,
    repaired: 0,
    alreadyCorrect: 0,
    missing: 0,
    failed: 0,
  };

  const renditions = and(
    like(fileVariants.type, 'hls\\_%'),
    ne(fileVariants.type, 'hls_master'),
    isNotNull(fileVariants.readyAt),
  );

  let lastId: string | null = null;
  for (;;) {
    const rows = await getDb()
      .select({
        id: fileVariants.id,
        fileId: fileVariants.fileId,
        type: fileVariants.type,
        key: fileVariants.key,
      })
      .from(fileVariants)
      .where(lastId ? and(renditions, gt(fileVariants.id, lastId)) : renditions)
      .orderBy(asc(fileVariants.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      result.playlists += 1;
      try {
        const playlist = (await s3.downloadBuffer(row.key)).toString('utf8');
        for (const uri of playlistUris(playlist)) {
          const target = playlistSiblingKey(row.key, uri);
          if (await s3.fileExists(target)) {
            result.alreadyCorrect += 1;
            continue;
          }
          let source: string | undefined;
          for (const candidate of legacySegmentKeys(row.key, row.type, uri)) {
            if (await s3.fileExists(candidate)) {
              source = candidate;
              break;
            }
          }
          if (!source) {
            result.missing += 1;
            continue;
          }
          result.repaired += 1;
          if (!dryRun) await s3.copyFile(source, target);
        }
      } catch (error) {
        // One unreadable playlist must not end the pass: the count says so, and
        // a re-run retries it.
        result.failed += 1;
        logger.warn('[repair-hls-segments] could not repair a playlist', {
          fileId: row.fileId,
          key: row.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[repair-hls-segments] progress', { dryRun, ...result });
    if (rows.length < batchSize) break;
  }

  return result;
}
