/**
 * Standalone consumer for CPU-heavy asset rendition jobs.
 *
 * This process deliberately starts no HTTP server or unrelated scheduler. The
 * API fleet only produces BullMQ jobs; this worker performs sharp/ffmpeg work
 * with bounded concurrency independently of API replica count.
 */

import 'dotenv/config';
import { startWorkerActivity, stopWorkerActivity } from './services/workerActivity.service';
import { shutdownTelemetry } from './telemetry';
import { closePostgres } from './config/postgres';
import { closeRedis } from './config/redis';
import {
  startAssetVariantWorker,
  stopAssetVariantWorker,
} from './queue/assetVariants.queue';
import { logger } from './utils/logger';
import { waitForDatabaseConnection } from './utils/dbConnection';

const WORKER_MAX_POOL_SIZE = 5;
const CONNECT_TIMEOUT_MS = 30_000;

const missingEnvironment = [
  'DATABASE_URL',
  'QUEUE_REDIS_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_S3_BUCKET',
].filter((name) => !process.env[name]);

if (missingEnvironment.length > 0) {
  logger.error('Asset-variant worker environment is incomplete', {
    missing: missingEnvironment,
  });
  process.exit(1);
}

if (!process.env.PG_MAX_POOL_SIZE) {
  process.env.PG_MAX_POOL_SIZE = String(WORKER_MAX_POOL_SIZE);
}

let ready = false;
startWorkerActivity('oxy-asset-variant-worker', () => ready);

async function start(): Promise<void> {
  logger.info('Starting Oxy asset-variant worker');
  await waitForDatabaseConnection(CONNECT_TIMEOUT_MS);
  await startAssetVariantWorker();
  ready = true;
  logger.info('Oxy asset-variant worker is running', {
    maxPoolSize: process.env.PG_MAX_POOL_SIZE,
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  logger.info(`${signal} received, stopping asset-variant worker`);
  await stopAssetVariantWorker();
  await stopWorkerActivity();
  await closeRedis();
  await closePostgres();
  await shutdownTelemetry();
  logger.info('Oxy asset-variant worker stopped');
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

start().catch((error: unknown) => {
  logger.error(
    'Asset-variant worker failed to start',
    error instanceof Error ? error : new Error(String(error)),
  );
  process.exit(1);
});
