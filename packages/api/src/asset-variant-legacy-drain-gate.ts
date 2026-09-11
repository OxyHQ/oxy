import 'dotenv/config';
import { Queue } from 'bullmq';
import { getQueueConnectionOptions } from './queue/connection';
import { logger } from './utils/logger';

const EMPTY_CHECKS_REQUIRED = 3;
const CHECK_INTERVAL_MS = 20_000;
const MAX_CHECKS = 45;

async function waitForLegacyQueueDrain(): Promise<void> {
  const queue = new Queue('asset-variants', { connection: getQueueConnectionOptions() });
  let consecutiveEmptyChecks = 0;

  try {
    await queue.waitUntilReady();
    for (let check = 1; check <= MAX_CHECKS; check += 1) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      const waiting = counts.waiting ?? 0;
      const active = counts.active ?? 0;
      const delayed = counts.delayed ?? 0;
      consecutiveEmptyChecks = waiting === 0 && active === 0 && delayed === 0
        ? consecutiveEmptyChecks + 1
        : 0;

      logger.info('Legacy asset variant queue drain check', {
        check,
        waiting,
        active,
        delayed,
        consecutiveEmptyChecks,
        requiredEmptyChecks: EMPTY_CHECKS_REQUIRED,
      });

      if (consecutiveEmptyChecks >= EMPTY_CHECKS_REQUIRED) return;
      await new Promise<void>((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    }
  } finally {
    await queue.close();
  }

  throw new Error('Legacy asset variant queue did not remain empty during the drain window');
}

waitForLegacyQueueDrain().catch((error: unknown) => {
  logger.error(
    'Legacy asset variant queue drain gate failed',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
