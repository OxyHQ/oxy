/**
 * Shared Jest worker-count computation for `jest.config.js` and
 * `jest.globalSetup.ts`. Both must agree on the same ceiling so global setup
 * provisions one throwaway Postgres database per worker.
 */
const { cpus, totalmem } = require('node:os');

/** Env var global setup writes and each worker reads to pick its database. */
const OXY_JEST_DATABASE_MANIFEST = 'OXY_JEST_DATABASE_MANIFEST';

// Every worker opens its OWN Postgres pool against the test server. With
// `PG_MAX_POOL_SIZE = 8`, ten workers ask for at most 80 connections against a
// `max_connections` of 100, leaving room for migrations and administration.
const POSTGRES_WORKER_CEILING = 10;

const WORKER_BYTES = 1_000_000_000;
const JEST_BASE_BYTES = 4_500_000_000;
const MEMORY_BUDGET_FRACTION = 0.75;

// Two Node 24.20.0 measurements each lost a Jest worker to SIGSEGV. Their cores
// end in V8's JSON parser and the accessible journal contains no OOM record.
// Keep parallelism at one as containment while retaining the resource model;
// this ceiling is not a claim that the underlying process crash is resolved.
const MEASURED_STABILITY_CEILING = 1;

/**
 * @returns {number} Jest `maxWorkers` — the smallest of the Postgres, CPU, and
 *   memory ceilings.
 */
function computeMaxWorkers() {
  return Math.min(
    MEASURED_STABILITY_CEILING,
    POSTGRES_WORKER_CEILING,
    Math.max(1, cpus().length - 1),
    Math.max(
      1,
      Math.floor((totalmem() * MEMORY_BUDGET_FRACTION - JEST_BASE_BYTES) / WORKER_BYTES)
    )
  );
}

module.exports = {
  OXY_JEST_DATABASE_MANIFEST,
  computeMaxWorkers,
};
