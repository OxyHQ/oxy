#!/usr/bin/env bun
/**
 * One-time repair: store every HLS segment under the name its rendition
 * playlist lists, so a player can fetch it.
 *
 * Why it exists:
 *   `variantService.generateHLSStream` uploaded each segment as
 *   `<renditionType>_<file>.ts` while the playlist ffmpeg wrote lists the plain
 *   file name. A playlist's URIs resolve against its own URL (RFC 8216
 *   §4.3.4.2), so every segment of every ladder resolved to a key that did not
 *   exist — measured in production on 2026-10-10:
 *
 *     playlist  cloud.oxy.so/variants/2026/10/16/<sha>/hls_360p.m3u8        200
 *     lists     segment_360p_000.ts                                          403
 *     stored    variants/2026/10/16/<sha>/hls_360p_segment_360p_000.ts.ts
 *
 *   The generator now stores segments as the playlist's siblings, and a
 *   visibility change copies them along, but both only help ladders built or
 *   moved after the fix. This script is the repair for what is already stored.
 *
 * Behavior:
 *   - Scans `file_variants` for ready rendition playlists (`hls_*`, not the
 *     master), in batches.
 *   - Reads each playlist and, for every segment it lists that is missing next
 *     to it, copies the legacy-named object there. The legacy object is looked
 *     for in both spellings of the directory: a ladder made public before the
 *     relocation copied segments still has them only under the private one.
 *   - Copies, never moves or deletes: the legacy keys are content-addressed and
 *     may back another owner's row, and deleting the asset sweeps the directory.
 *   - Idempotent and safe to re-run: a segment already in place is counted as
 *     `alreadyCorrect` and left alone.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/repair-hls-segment-keys.ts
 *
 * Env:
 *   DATABASE_URL   Postgres connection string (required, injected by ECS from SSM)
 *   BATCH_SIZE     Rows to scan per batch (default 200)
 *   DRY_RUN=true   Report what would change without writing (default false)
 */

import { closePostgres, connectPostgres } from '../config/postgres';
import { logger } from '../utils/logger';
import { repairHlsSegmentKeys } from './hlsSegmentKeyRepair';

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);

  try {
    await connectPostgres();
    const result = await repairHlsSegmentKeys({
      dryRun,
      batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : undefined,
    });
    logger.info('[repair-hls-segments] complete', { dryRun, ...result });
    if (result.failed > 0) process.exitCode = 75;
  } finally {
    await closePostgres();
  }
}

main().catch((error) => {
  logger.error(
    '[repair-hls-segments] failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
