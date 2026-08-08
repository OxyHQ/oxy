/**
 * Jest global setup — Postgres.
 *
 * Creates one throwaway, fully-migrated database PER WORKER and writes their
 * URLs to a manifest file. `jest.setupWorkerDatabase.cjs` runs in each worker
 * before test files load and points `DATABASE_URL` at that worker's database,
 * so parallel suites cannot race on shared rows.
 *
 * This runs for EVERY `bun run test`, so a reachable Postgres is a hard
 * prerequisite of the suite — deliberately, since the alternative (skipping
 * silently when the database is absent) is a check that cannot tell success
 * from failure. Start one with:
 *   docker compose -f docker-compose.dev.yml up -d postgres
 *
 * The Mongo side is untouched: `jest.setup.cjs` still mocks mongoose wholesale.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabases } from './src/db/testDatabase';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { computeMaxWorkers, OXY_JEST_DATABASE_MANIFEST } = require('./jest.workerCount.cjs');

/**
 * Connections one worker's pool may open. Deliberately tiny, and NOT a tuning
 * knob — it is the only thing keeping the run under the server's ceiling.
 *
 * The runtime default is 20, sized for a long-lived API process. Jest forks one
 * worker per core minus one (31 on this machine) and each opens its OWN pool
 * against the same server, so the default asks for up to 620 connections
 * against a `max_connections` of 100.
 *
 * 8 was originally a FLOOR: the Mongo→Postgres backfill copied collections with
 * a concurrency of 8, and a smaller pool starved it against itself — measured at
 * 2, its three suites did not merely slow down, they ran 67–74s and timed out,
 * consistently, all three. Those suites are gone with the backfill, so nothing
 * forces a floor any more. 8 stays because it is the number the ceiling
 * arithmetic in `jest.config.js` is built from and the value this suite is
 * measured green at; changing it is a measurement, not an edit. `maxWorkers`
 * there is the other half: 8 × 31 workers is still far past the ceiling, so the
 * two numbers only work together.
 *
 * That does not fail where the fault is. The server refuses whichever worker
 * happens to ask while it is saturated, so a DIFFERENT, entirely innocent suite
 * goes red on each run — measured here across five consecutive runs:
 * `deviceTransfer`, `dbConnection`, `platformStats`, `nodeRegistry`,
 * `reputation.leaderboard`, every one of them passing in isolation. The cost is
 * not the flake itself but that it makes a real regression indistinguishable
 * from noise, which is the state a suite is least useful in.
 *
 * Set BEFORE jest forks, so every worker inherits it; an explicit
 * `PG_MAX_POOL_SIZE` in the environment still wins, for anyone deliberately
 * measuring pool behaviour.
 */
const TEST_MAX_POOL_SIZE = '8';

export default async function globalSetup(): Promise<void> {
  process.env.PG_MAX_POOL_SIZE ??= TEST_MAX_POOL_SIZE;

  const workerCount = computeMaxWorkers();
  const urls = await createTestDatabases(workerCount);

  const manifestPath = join(tmpdir(), `oxy-jest-databases-${process.pid}.json`);
  writeFileSync(manifestPath, JSON.stringify(urls));
  process.env[OXY_JEST_DATABASE_MANIFEST] = manifestPath;

  // Global setup and teardown share this process; keep a valid URL for teardown
  // guards and any code that runs before workers fork.
  process.env.DATABASE_URL = urls[0];
}
