/**
 * Per-worker Postgres routing — runs in every Jest worker BEFORE test files load.
 *
 * `jest.globalSetup.ts` provisions one migrated throwaway database per worker and
 * writes their URLs to a manifest file. Each worker reads that manifest and sets
 * `DATABASE_URL` to its own entry so parallel suites cannot race on shared rows.
 */
const { readFileSync } = require('node:fs');
const { OXY_JEST_DATABASE_MANIFEST } = require('./jest.workerCount.cjs');

const manifestPath = process.env[OXY_JEST_DATABASE_MANIFEST];
if (!manifestPath) {
  throw new Error(
    `${OXY_JEST_DATABASE_MANIFEST} is unset — jest.globalSetup.ts must run before workers`
  );
}

const urls = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(urls) || urls.length === 0) {
  throw new Error(`Invalid Jest database manifest at ${manifestPath}`);
}

const workerId = Number.parseInt(process.env.JEST_WORKER_ID ?? '1', 10);
const index = workerId - 1;
if (!Number.isFinite(workerId) || index < 0 || index >= urls.length) {
  throw new Error(
    `JEST_WORKER_ID=${process.env.JEST_WORKER_ID ?? '(unset)'} is out of range ` +
      `for ${urls.length} provisioned database(s)`
  );
}

process.env.DATABASE_URL = urls[index];
