/**
 * The large-upload worker (ADR 0043 stage 4b), on every API task.
 *
 * Each tick verifies the `verifying` uploads whose lease is free — the ones a
 * `complete` request handed off after its wait, and any whose verifier died —
 * and aborts the `uploading` ones nobody completed by their deadline (S3
 * discards their parts; a storage reservation is released). Leases make it
 * safe on every task at once (`FileUploadSessionService.verify`).
 *
 * ON by default: there is nothing to do until an application opens an upload.
 * `FILE_UPLOAD_WORKER_ENABLED=false` switches it off (a completed upload then
 * stays `verifying` until it is switched back on);
 * `FILE_UPLOAD_WORKER_INTERVAL_MS` (default 30 s) paces it.
 */

import { getEnvBoolean, getEnvNumber } from '../config/env';
import { logger } from '../utils/logger';
import { fileUploadSessionService } from './fileUploadSessionSingleton';

const DEFAULT_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const result = await fileUploadSessionService.sweep();
    if (result.verified > 0 || result.expired > 0) {
      logger.info('[FileUploads] Sweep', result);
    }
  } catch (error) {
    logger.error(
      '[FileUploads] Sweep failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

export function startFileUploadSessionWorker(): boolean {
  if (!getEnvBoolean('FILE_UPLOAD_WORKER_ENABLED', true)) {
    logger.info('[FileUploads] Worker disabled; completed large uploads wait in `verifying`');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('FILE_UPLOAD_WORKER_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    1_000,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  logger.info('[FileUploads] Worker started', { intervalMs });
  return true;
}

export function stopFileUploadSessionWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
