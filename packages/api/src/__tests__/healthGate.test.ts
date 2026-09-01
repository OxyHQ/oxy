/**
 * `GET /health` — the ALB target-group check.
 *
 * ## Why this suite exists, and why the obvious version of it is worthless
 *
 * A 503 here DRAINS the task out of the load balancer. So the endpoint has
 * exactly two failure modes and both are outages: report healthy while the
 * database refuses work (a real outage reads as green and nothing rotates), or
 * report 503 while it is fine (the ALB pulls every task).
 *
 * The obvious test — point `DATABASE_URL` at nothing, boot, expect 503 —
 * SURVIVES the mutation it is supposed to catch. `checkPostgresHealth` returns
 * `false` early when no pool has been published, so a build where the probe is
 * `return client !== null` instead of a real `select 1` answers "down" in that
 * setup too. The two implementations are indistinguishable when the database was
 * never reachable in the first place.
 *
 * The honest shape is the one below: bring a REAL pool up against a REAL
 * database, prove `/health` is 200, then drop the database out from under the
 * live pool. Now the pool object still exists and the server does not answer —
 * the only state where "there is a connection handle" and "the database works"
 * disagree, and therefore the only state that can tell a real probe from a flag
 * read.
 *
 * The suite owns its own throwaway database precisely because dropping it is the
 * experiment.
 */

// The run-wide setup replaces `socket.io` with a stub that has no `.use`, and
// importing the real `server.ts` attaches middleware to a real `Server`.
jest.unmock('socket.io');

// `server.ts` runs `validateRequiredEnvVars()` at import and `process.exit(1)`s
// when anything is missing — which would take the whole jest worker with it.
// CI supplies these; a developer running `bun run test` with no `.env` does not.
// `??=` so a real value always wins. No MONGODB_URI placeholder: it is not a
// required var any more, and `bootGate.test.ts` is where that is held.
process.env.ACCESS_TOKEN_SECRET ??= 'health-gate-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'health-gate-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'health-gate';
process.env.AWS_SECRET_ACCESS_KEY ??= 'health-gate';
process.env.AWS_S3_BUCKET ??= 'health-gate';

import type { AddressInfo } from 'net';
import postgres from 'postgres';
import { closePostgres, connectPostgres } from '../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../db/testDatabase';

interface HealthResponse {
  status: string;
  timestamp: string;
  database?: string;
  redis?: string;
  error?: string;
}

/** Creating and migrating a database outlasts the 10s default. */
const SLOW_STEP_TIMEOUT_MS = 120_000;

let server: import('http').Server;
let ownDatabaseUrl = '';
let sharedDatabaseUrl: string | undefined;

async function health(): Promise<{ status: number; body: HealthResponse }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: (await response.json()) as HealthResponse };
}

beforeAll(async () => {
  sharedDatabaseUrl = process.env.DATABASE_URL;
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
  server = (await import('../server')).default;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
  // Idempotent (`drop database if exists`) — the last case already dropped it.
  await dropTestDatabase(ownDatabaseUrl);
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

describe('GET /health', () => {
  it('answers 200 while the database really answers', async () => {
    const { status, body } = await health();

    expect(status).toBe(200);
    expect(body.database).toBe('connected');
    // `operational` with Redis, `degraded` without — never `down`, which is the
    // only value paired with a 503.
    expect(['operational', 'degraded']).toContain(body.status);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  // MUST stay last: it destroys the database this suite is pointed at.
  it('answers 503 once the database stops answering UNDER A LIVE POOL', async () => {
    // The pool is open and has already served a query. Dropping the database
    // with `FORCE` terminates its backends, so the next query on the SAME pool
    // fails — while `client` is still a perfectly good object. A probe that
    // reports on the handle rather than on the server cannot tell the
    // difference, which is exactly what this asserts it does not do.
    await dropTestDatabase(ownDatabaseUrl);

    const { status, body } = await health();

    expect(status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.database).toBe('disconnected');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  }, SLOW_STEP_TIMEOUT_MS);

  it('keeps answering 503 — a dead database does not heal itself', async () => {
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.status).toBe('down');
  });

  it('the database really is gone, not merely reported gone', async () => {
    // Proof the previous cases are testing the condition they claim: an
    // independent connection to the same name is refused by the server.
    const name = new URL(ownDatabaseUrl).pathname.replace(/^\//, '');
    const probe = postgres(ownDatabaseUrl, { max: 1, connect_timeout: 5 });
    await expect(probe`select 1`).rejects.toThrow(new RegExp(`"${name}" does not exist`));
    await probe.end({ timeout: 5 });
  });
});
