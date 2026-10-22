#!/usr/bin/env bun
/**
 * Move named files whose bytes are gone for good to `lost` (ADR 0043 D13).
 *
 * The repair for a live `files` row that names an object no store holds — found
 * by a storage audit (the R2 migration's hash of every row, oxy-infra runbook
 * 61), not by one failed read. Each id goes through
 * `assetService.markFileLost`, which looks for the object in both spellings
 * under the content-hash lock, re-fetches a federated copy from its origin
 * first, and refuses a federation cache entry (its using service evicts and
 * re-caches it). The row is kept; the owner sees the file as lost, and every
 * application using it gets `file.lost`.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/mark-lost-files.ts <fileId> [<fileId> …]
 *
 * Env:
 *   DATABASE_URL, R2_*   as the API (injected by ECS)
 *   APPLY=true           mark the files; without it, only report what each one is
 */

import { closePostgres, connectPostgres } from '../config/postgres';
import { closeRedis, getRedisClient } from '../config/redis';
import { findFileById } from '../services/fileRepository';
import { assetService } from '../services/assetServiceSingleton';
import { s3Service } from '../services/s3ServiceSingleton';
import { applyPublicPrefix, stripPublicPrefix } from '../config/cdn';
import { flushCdnInvalidations } from '../services/cdnInvalidation';
import { logger } from '../utils/logger';

/** `getRedisClient()` starts connecting; wait until it is ready, for at most 15 s. */
async function redisReady(): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis was not ready within 15 s')), 15_000);
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function report(fileId: string): Promise<string> {
  const file = await findFileById(fileId);
  if (!file) return 'not_live';
  const keys = [
    ...new Set([stripPublicPrefix(file.storageKey), applyPublicPrefix(file.storageKey)]),
  ];
  const present = await Promise.all(keys.map((key) => s3Service.fileExists(key)));
  return `${file.status}, object ${present.some(Boolean) ? 'present' : 'absent in every spelling'}`;
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((arg) => arg.length > 0);
  if (ids.length === 0) throw new Error('Name at least one file id');
  const apply = process.env.APPLY === 'true';
  await connectPostgres();
  // Ready before any change, so the cross-task file-cache invalidation a mark
  // publishes reaches every API task (it is skipped while Redis is not ready).
  await redisReady();
  try {
    let failed = 0;
    for (const fileId of ids) {
      const outcome = apply ? await assetService.markFileLost(fileId) : await report(fileId);
      logger.info('[mark-lost-files]', { fileId, apply, outcome });
      if (apply && outcome !== 'lost') failed += 1;
    }
    if (failed > 0) process.exitCode = 75;
  } finally {
    // The CDN purges a lost file's paths queued; send them before exiting.
    await flushCdnInvalidations();
    await closeRedis();
    await closePostgres();
  }
}

// Exits when done: a one-off task otherwise stays up on whatever timers the
// API's modules started (the purge queue, the caches).
main()
  .then(() => process.exit())
  .catch((error) => {
    logger.error(
      '[mark-lost-files] failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  });
