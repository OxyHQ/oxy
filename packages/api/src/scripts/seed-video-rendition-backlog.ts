#!/usr/bin/env bun
import { connectPostgres, closePostgres } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { seedVideoRenditionBacklog } from './video-rendition-backlog';
import { logger } from '../utils/logger';

async function main() {
  try {
    await connectPostgres();
    const result = await seedVideoRenditionBacklog({
      applicationId: process.env.APPLICATION_ID ?? '',
      dryRun: process.env.DRY_RUN !== 'false',
      limit: process.env.LIMIT ? Number(process.env.LIMIT) : undefined,
      maxGroups: process.env.MAX_GROUPS ? Number(process.env.MAX_GROUPS) : undefined,
      after: process.env.AFTER || undefined,
    });
    logger.info('Video rendition backlog seed complete', result);
  } finally {
    try {
      await closePostgres();
    } finally {
      await closeRedis();
    }
  }
}
main().catch((error: unknown) => {
  logger.error('Video rendition backlog seed aborted', { error });
  process.exitCode = 1;
});
