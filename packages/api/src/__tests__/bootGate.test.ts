/**
 * The startup gate — the API must not accept a connection before the database
 * answers, and the work chained behind the gate must actually run.
 *
 * ## The two guarantees
 *
 * 1. **Nothing listens until the database answers.** `server.listen` is the last
 *    thing `bootstrap()` does, after `await waitForDatabaseConnection(...)`. If
 *    it escaped that await, a task would join the ALB target group and start
 *    serving 500s the moment the process started. Asserted by booting against a
 *    database that does not exist and proving the server is NOT listening when
 *    the gate rejects.
 * 2. **The seeds chained behind the gate run.** `seedDefaultRules` and
 *    `seedBaselinePolicy` are idempotent seeds later write paths assume — the
 *    moderation bridge REJECTS every event naming a policy version it cannot
 *    find, so a boot that skipped them looks healthy and fails at the first real
 *    request. Asserted by reading the seeded rows back out of the database.
 * 3. **The API boots without MongoDB.** Mongo is not a dependency of the
 *    serving process.
 *
 * ## Why the failure case must run FIRST
 *
 * `connectPostgres()` is idempotent: once a pool is published, every later call
 * returns it without touching the network. So "the database is unreachable" is
 * only representable before anything in this process has connected. The two
 * cases are therefore ORDERED, and the second one is what leaves a live pool
 * behind.
 */

// The run-wide setup replaces `socket.io` with a stub that has no `.use`, and
// importing the real `server.ts` attaches middleware to a real `Server`.
jest.unmock('socket.io');

// `server.ts` runs `validateRequiredEnvVars()` at import and `process.exit(1)`s
// when anything is missing — which would take the whole jest worker with it.
// CI supplies these; a developer running `bun run test` with no `.env` does not.
// `??=` so a real value always wins.
//
process.env.ACCESS_TOKEN_SECRET ??= 'boot-gate-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'boot-gate-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'boot-gate';
process.env.AWS_SECRET_ACCESS_KEY ??= 'boot-gate';
process.env.AWS_S3_BUCKET ??= 'boot-gate';

import { createServer } from 'node:net';
import type { Server } from 'node:http';
import postgres from 'postgres';
import { closePostgres } from '../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../db/testDatabase';
import { stopBackgroundJobs } from '../queue/backgroundJobs';
import { stopConductRiskExpiryJobs } from '../queue/conductRiskExpiry.queue';
import { stopLinkPreviewWarmJobs } from '../queue/linkPreviewWarm.queue';
import { stopNodeIngestJobs } from '../queue/nodeIngest.queue';
import { stopSubscriptionExpiryJobs } from '../queue/subscriptionExpiry.queue';
import { stopTransparencyCheckpointJobs } from '../queue/transparencyCheckpoint.queue';
import { BASELINE_OXY_CONDUCT_POLICY_VERSION } from '../utils/moderation.constants';

/** Creating + migrating a database, then booting the whole API, outlast the default. */
const SLOW_STEP_TIMEOUT_MS = 180_000;

/**
 * The deadline the unreachable-database case boots with.
 *
 * The production value is 30s of retrying; the behaviour under test is what
 * happens when it runs out, so a short one exercises the same branch without
 * spending the wall clock. The retry loop itself is covered by
 * `utils/dbConnection.ts`'s own contract.
 */
const SHORT_STARTUP_DEADLINE_MS = 300;

let server: Server;
let bootstrap: (startupTimeoutMs?: number) => Promise<void>;
let ownDatabaseUrl = '';
let sharedDatabaseUrl: string | undefined;

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not resolve a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  sharedDatabaseUrl = process.env.DATABASE_URL;
  // `PORT` is read once, at module scope, so it has to be set before the import.
  process.env.PORT = String(await freePort());
  // A database that exists on a REACHABLE server: every connection attempt
  // fails immediately with `database … does not exist`, which is the shape the
  // first case needs.
  const absent = new URL(sharedDatabaseUrl ?? '');
  absent.pathname = '/oxy_boot_gate_absent';
  process.env.DATABASE_URL = absent.toString();

  const module = await import('../server');
  server = module.default;
  bootstrap = module.bootstrap;
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  // This suite really does start the process's background work, so it really
  // has to stop it — the same six calls `gracefulShutdown` makes. Their
  // no-Redis fallback is a plain `setInterval`, so leaving them running holds
  // the jest worker open after the run finishes.
  await stopBackgroundJobs();
  await stopNodeIngestJobs();
  await stopTransparencyCheckpointJobs();
  await stopLinkPreviewWarmJobs();
  await stopConductRiskExpiryJobs();
  await stopSubscriptionExpiryJobs();
  await closePostgres();
  if (ownDatabaseUrl !== '') {
    await dropTestDatabase(ownDatabaseUrl);
  }
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

describe('startup gate', () => {
  // MUST stay first — see the header: a published pool makes the unreachable
  // case unrepresentable.
  it('rejects and does NOT listen while the database is unreachable', async () => {
    expect(server.listening).toBe(false);

    await expect(bootstrap(SHORT_STARTUP_DEADLINE_MS)).rejects.toThrow(
      /PostgreSQL connection timeout/,
    );

    // The whole point: the gate rejected and nothing is accepting connections.
    // A `server.listen` that escaped the await fails HERE.
    expect(server.listening).toBe(false);
  }, SLOW_STEP_TIMEOUT_MS);

  it(
    'listens once the database answers, and the seeds chained behind it have run',
    async () => {
      ownDatabaseUrl = await createTestDatabase();

      await bootstrap();

      expect(server.listening).toBe(true);

      // It really is serving, not just flagged as listening.
      const response = await fetch(`http://127.0.0.1:${process.env.PORT}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ database: 'connected' });

      // Guarantee (2), read over an INDEPENDENT connection so the assertion does
      // not depend on the pool the server just published.
      const sql = postgres(ownDatabaseUrl, { max: 1 });
      try {
        const rules = await sql`
          select action_type from reputation_rules where action_type = 'endorsement_received'
        `;
        expect(rules).toHaveLength(1);

        const policies = await sql`
          select policy_version from moderation_policies
          where policy_version = ${BASELINE_OXY_CONDUCT_POLICY_VERSION}
        `;
        expect(policies).toHaveLength(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    SLOW_STEP_TIMEOUT_MS,
  );
});
