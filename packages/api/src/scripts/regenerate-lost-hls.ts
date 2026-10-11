#!/usr/bin/env bun
/**
 * Repair: encode again, from the original, every live video whose HLS
 * playlists point at objects that no longer exist.
 *
 * Why it exists:
 *   The segment-key repair (`repair-hls-segment-keys.ts`) reads each rendition
 *   playlist and fixes the segments it lists. On 2026-10-10 it found 21
 *   playlists, across 18 videos, whose `.m3u8` itself was gone from storage
 *   while `file_variants` still named it — some with their segments still
 *   beside them. Nothing can be copied back for those: the playlist is the
 *   part that was lost, so the ladder has to be encoded again.
 *
 * Behavior:
 *   - Scans the ready HLS playlist rows (`hls_*`, master included) of live
 *     files and checks each object exists.
 *   - Groups the files with a lost playlist by content and visibility
 *     spelling: twins name the same content-addressed objects, so one encode
 *     per group is handed to every twin (`generateVariants({ reencode })`).
 *   - Skips a group whose original is gone as well, and reports it.
 *   - Writes a fresh rendition set and replaces the rows by type; it deletes
 *     nothing in storage. Safe to re-run: a mended file has no lost playlist.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/regenerate-lost-hls.ts
 *
 * Env:
 *   DATABASE_URL   Postgres connection string (required, injected by ECS from SSM)
 *   BATCH_SIZE     Rows to scan per batch (default 200)
 *   DRY_RUN=true   Report what would be encoded without encoding (default false)
 */

import { closePostgres, connectPostgres } from '../config/postgres';
import { logger } from '../utils/logger';
import { regenerateLostHls } from './lostHlsRegeneration';

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);

  try {
    await connectPostgres();
    const result = await regenerateLostHls({
      dryRun,
      batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : undefined,
    });
    logger.info('[regenerate-lost-hls] complete', { dryRun, ...result });
    if (result.failed > 0) process.exitCode = 75;
  } finally {
    await closePostgres();
  }
}

main().catch((error) => {
  logger.error(
    '[regenerate-lost-hls] failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
