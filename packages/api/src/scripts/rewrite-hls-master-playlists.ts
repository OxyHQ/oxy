#!/usr/bin/env bun
/**
 * One-time repair: rewrite the rendition URIs inside every stored HLS master
 * playlist so a player can follow them.
 *
 * Why it exists:
 *   `variantService.generateMasterPlaylist` listed each rendition by its S3
 *   STORAGE KEY. A master's URIs resolve against the MASTER's own URL
 *   (RFC 8216 §4.3.4.2), so the key resolves to a path that does not exist —
 *   measured against production before the generator was fixed:
 *
 *     master   cloud.oxy.so/variants/2026/09/e8/<sha>/hls_master.m3u8      200
 *     its URI  public/variants/2026/09/e8/<sha>/hls_360p.m3u8
 *     resolves cloud.oxy.so/variants/2026/09/e8/<sha>/public/variants/…    403
 *     correct  cloud.oxy.so/variants/2026/09/e8/<sha>/hls_360p.m3u8        200
 *
 *   Every ladder ever produced is unplayable, and the generator fix only helps
 *   ladders built after it. Masters already in S3 are rewritten only when a
 *   variant set is rebuilt, which nothing triggers on its own — so this script
 *   is the repair for what is already stored.
 *
 * Behavior:
 *   - Scans `file_variants` for ready `hls_master` rows, in batches.
 *   - Downloads each master, replaces every URI line with its BASENAME (master
 *     and renditions share one directory by construction), and writes it back
 *     under the same key, content type and cache control.
 *   - A master whose URIs are already basenames is left untouched and counted
 *     as `alreadyCorrect` — the pass is idempotent and safe to re-run.
 *   - Never invents renditions: only existing URI lines are rewritten, in place
 *     and in order, and a playlist with no URI lines is reported, not "fixed".
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/rewrite-hls-master-playlists.ts
 *
 * Env:
 *   DATABASE_URL   Postgres connection string (required, injected by ECS from SSM)
 *   BATCH_SIZE     Rows to scan per batch (default 200)
 *   DRY_RUN=true   Report what would change without writing (default false)
 */

import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { fileVariants } from '../db/schema/fileVariants';
import { HLS_MASTER_PLAYLIST_CACHE_CONTROL } from '../config/cdn';
import type { S3Service } from '../services/s3Service';
import { s3Service } from '../services/s3ServiceSingleton';
import { logger } from '../utils/logger';
import { rewriteMasterPlaylist } from './hlsMasterPlaylistRewrite';

const HLS_MASTER_VARIANT_TYPE = 'hls_master';
const MASTER_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

export interface RewriteHlsMastersResult {
  scanned: number;
  rewritten: number;
  alreadyCorrect: number;
  empty: number;
  failed: number;
}

export async function rewriteHlsMasterPlaylists(
  opts: { batchSize?: number; dryRun?: boolean; s3?: S3Service } = {},
): Promise<RewriteHlsMastersResult> {
  const batchSize = opts.batchSize ?? 200;
  const dryRun = opts.dryRun ?? false;
  const s3 = opts.s3 ?? s3Service;

  const result: RewriteHlsMastersResult = {
    scanned: 0,
    rewritten: 0,
    alreadyCorrect: 0,
    empty: 0,
    failed: 0,
  };

  let lastId: string | null = null;
  for (;;) {
    const rows = await getDb()
      .select({ id: fileVariants.id, fileId: fileVariants.fileId, key: fileVariants.key })
      .from(fileVariants)
      .where(
        lastId
          ? and(
              eq(fileVariants.type, HLS_MASTER_VARIANT_TYPE),
              isNotNull(fileVariants.readyAt),
              gt(fileVariants.id, lastId),
            )
          : and(eq(fileVariants.type, HLS_MASTER_VARIANT_TYPE), isNotNull(fileVariants.readyAt)),
      )
      .orderBy(asc(fileVariants.id))
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      result.scanned += 1;
      lastId = row.id;
      try {
        const original = (await s3.downloadBuffer(row.key)).toString('utf8');
        const { playlist, uriLines } = rewriteMasterPlaylist(original);

        if (uriLines === 0) {
          result.empty += 1;
          logger.warn('[rewrite-hls-masters] master lists no renditions', {
            fileId: row.fileId,
            key: row.key,
          });
          continue;
        }
        if (playlist === original) {
          result.alreadyCorrect += 1;
          continue;
        }

        result.rewritten += 1;
        if (dryRun) continue;

        await s3.uploadBuffer(row.key, Buffer.from(playlist), {
          contentType: MASTER_CONTENT_TYPE,
          cacheControl: HLS_MASTER_PLAYLIST_CACHE_CONTROL,
        });
      } catch (error) {
        // One unreadable object must not end the pass: the row keeps its broken
        // master, the count says so, and a re-run retries it.
        result.failed += 1;
        logger.warn('[rewrite-hls-masters] could not repair a master', {
          fileId: row.fileId,
          key: row.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[rewrite-hls-masters] progress', { dryRun, ...result });

    if (rows.length < batchSize) break;
  }

  return result;
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);

  try {
    await connectPostgres();
    const result = await rewriteHlsMasterPlaylists({
      dryRun,
      batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : undefined,
    });
    logger.info('[rewrite-hls-masters] complete', { dryRun, ...result });
    if (result.failed > 0) process.exitCode = 75;
  } finally {
    await closePostgres();
  }
}

main().catch((error) => {
  logger.error(
    '[rewrite-hls-masters] failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
