/**
 * Shared Jest worker-count computation for `jest.config.js` and
 * `jest.globalSetup.ts`. Both must agree on the same ceiling so global setup
 * provisions one throwaway Postgres database per worker.
 */
/** Env var global setup writes and each worker reads to pick its database. */
const OXY_JEST_DATABASE_MANIFEST = 'OXY_JEST_DATABASE_MANIFEST';

// The suite performs sustained secp256k1 work through elliptic/bn.js. With
// Node 24.14.1, three and ten worker runs reproducibly abort inside V8 with
// SIGSEGV/SIGTRAP while the same suites pass in one worker. Node 22 is less
// stable and can abort even in-band, which is why CI and production use Node 24.
// Keep one worker until the crypto implementation no longer depends on bn.js;
// retries are deliberately not used because they would hide native crashes.
const STABLE_WORKER_COUNT = 1;

/**
 * @returns {number} Jest `maxWorkers` — the smallest of the Postgres, CPU, and
 *   memory ceilings.
 */
function computeMaxWorkers() {
  return STABLE_WORKER_COUNT;
}

module.exports = {
  OXY_JEST_DATABASE_MANIFEST,
  computeMaxWorkers,
};
