/**
 * Snooze, reminder, and scheduled send processor.
 *
 * The actual work — `runEmailMaintenance()` — is transport-agnostic: it runs the
 * three email-service maintenance passes, each guarded by its own try/catch so a
 * failure in one does not skip the others. Both the BullMQ repeatable worker
 * (the durable, fleet-wide path) and the legacy in-process `setInterval` cron
 * (the local-dev / no-Redis fallback) call this SAME function, so there is no
 * duplicated business logic between the two paths.
 *
 * The legacy `setInterval` runs on every replica and is only used when BullMQ
 * queues are disabled (no `REDIS_URL`). See `src/queue/backgroundJobs.ts` for
 * the gate that chooses between the two.
 */

import { emailService } from '../services/email.service';
import { logger } from '../utils/logger';
import { EMAIL_MAINTENANCE_INTERVAL_MS } from '../queue/constants';
import { processEmailOutbox } from '../services/emailOutbox.worker';

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Run the three email-maintenance passes. Each pass is isolated so one failure
 * does not prevent the others from running. Never throws — failures are logged.
 *
 * Shared by the BullMQ worker and the legacy interval. Do NOT change the
 * business semantics here without changing both transports intentionally.
 */
export async function runEmailMaintenance(): Promise<void> {
  try {
    await emailService.processSnoozedMessages();
  } catch (err) {
    logger.error('Snooze cron failed', err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await emailService.processDueReminders();
  } catch (err) {
    logger.error('Reminder cron failed', err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await emailService.processScheduledMessages();
  } catch (err) {
    logger.error('Scheduled send cron failed', err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await processEmailOutbox();
  } catch (err) {
    logger.error('Durable outbound email worker failed', err instanceof Error ? err : new Error(String(err)));
  }
}

export function startSnoozeCron(): void {
  if (timer) return; // Already running

  timer = setInterval(() => {
    void runEmailMaintenance();
  }, EMAIL_MAINTENANCE_INTERVAL_MS);
  timer.unref?.();

  logger.info('Snooze, reminder & scheduled send cron started (in-process fallback, 60s interval)');
}

export function stopSnoozeCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
