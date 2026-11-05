#!/usr/bin/env bun
import { connectPostgres, closePostgres } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { flushCdnInvalidations } from '../services/cdnInvalidation';
import { repairVideoRenditions } from './video-rendition-repair';
import { logger } from '../utils/logger';

async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  try {
    await connectPostgres();
    const result = await repairVideoRenditions({
      dryRun,
      limit: process.env.LIMIT ? Number(process.env.LIMIT) : undefined,
      fileId: process.env.FILE_ID || undefined,
      after: process.env.AFTER || undefined,
    });
    logger.info('Video rendition repair complete', { dryRun, ...result });
    if (result.failed || result.unrecoverable) process.exitCode = 75;
  } finally {
    try {
      await flushCdnInvalidations();
    } finally {
      try {
        await closePostgres();
      } finally {
        await closeRedis();
      }
    }
  }
}

main().catch((error: unknown) => {
  logger.error('Video rendition repair aborted', { error });
  process.exitCode = 1;
});
