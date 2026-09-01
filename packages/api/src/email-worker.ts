/**
 * Email Worker — Standalone SMTP Server Process
 *
 * This is a separate entry point that runs ONLY the SMTP inbound/outbound
 * services. It connects to the same PostgreSQL as the main API but does NOT
 * start Express or any HTTP routes.
 *
 * Designed to run on a VPS where port 25 is accessible, while the main API
 * continues running on ECS.
 *
 * Usage:
 *   node dist/email-worker.js
 *
 * Both this worker and the API share one database — messages stored by the
 * SMTP worker are immediately visible via the /email/* REST endpoints.
 *
 * ## Its own, SMALLER pool — the reason it sets one at all
 *
 * A Postgres connection is a server-side PROCESS, so every replica's pool is
 * charged against one shared `max_connections`. This worker is one process
 * handling SMTP sessions rather than a fleet serving HTTP, so it takes a small
 * fixed slice ({@link WORKER_MAX_POOL_SIZE}) instead of the API's default. It
 * sets `PG_MAX_POOL_SIZE` before connecting rather than taking a parameter,
 * because `connectPostgres()` is the SINGLE place a pool is opened in this
 * package — adding a second, worker-specific connect path is exactly the kind
 * of parallel copy that drifts.
 *
 * An explicit `PG_MAX_POOL_SIZE` in the environment still wins: the deployment
 * that knows what else shares the database outranks this default.
 */

import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { startSmtpInbound, stopSmtpInbound } from './services/smtp.inbound';
import { smtpOutbound } from './services/smtp.outbound';
import { closePostgres } from './config/postgres';
import { closeRedis } from './config/redis';
import { waitForDatabaseConnection } from './utils/dbConnection';

dotenv.config();

/**
 * Connections this worker takes. Matches the `maxPoolSize: 10` it asked Mongo
 * for; the Mongo `minPoolSize: 2` has no counterpart worth reproducing, since
 * `postgres.js` opens lazily and closes on `idle_timeout` rather than holding a
 * floor.
 */
const WORKER_MAX_POOL_SIZE = 10;

/** How long startup waits for the database before giving up. */
const CONNECT_TIMEOUT_MS = 30_000;

if (!process.env.DATABASE_URL) {
  logger.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

if (!process.env.PG_MAX_POOL_SIZE) {
  process.env.PG_MAX_POOL_SIZE = String(WORKER_MAX_POOL_SIZE);
}

async function start(): Promise<void> {
  logger.info('Starting Oxy Email Worker...');

  // Same retry-until-deadline gate the API uses: `postgres.js` makes a single
  // connection attempt, and a worker that starts beside a database still
  // finishing a failover must wait rather than crash-loop.
  await waitForDatabaseConnection(CONNECT_TIMEOUT_MS);
  logger.info('PostgreSQL connected', { maxPoolSize: process.env.PG_MAX_POOL_SIZE });

  // Start SMTP inbound server
  startSmtpInbound();
  logger.info('SMTP inbound server started');

  // Outbound service is initialized on import (ready to send)
  logger.info('SMTP outbound service ready');

  logger.info('Oxy Email Worker is running');
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info('Shutting down Email Worker...');
  await stopSmtpInbound();
  smtpOutbound.shutdown();
  await closePostgres();
  await closeRedis();
  logger.info('Email Worker stopped');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  logger.error('Email Worker failed to start:', error);
  process.exit(1);
});
