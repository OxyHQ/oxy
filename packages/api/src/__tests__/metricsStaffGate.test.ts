/**
 * `GET /metrics` — the staff gate (issue #972).
 *
 * ## What this file is standing in front of
 *
 * The endpoint was mounted `app.get("/metrics", authMiddleware, …)` under a
 * comment reading "protected, for admin/internal use". `authMiddleware` proves
 * only that the caller holds a valid session, so the audience the comment named
 * and the audience the code admitted were not the same set: every authenticated
 * Oxy user could read this process's memory figures, the DATABASE HOSTNAME and
 * name out of `DATABASE_URL`, and the slow-operation list — which is keyed by
 * `` `${req.method} ${req.path}` `` with the path unparameterized, so it
 * enumerates the internal request surface complete with whatever ids and
 * usernames happened to be slow.
 *
 * ## Why each assertion is shaped the way it is
 *
 * **The refusal is asserted on 403 specifically, never on "not 200".** A broken
 * fixture — a bearer that never authenticated, a route that is unmounted, a
 * handler that throws — refuses just as convincingly as a guard does, and every
 * one of those answers 401, 404 or 500. Only `requireStaff` answers 403, and
 * only `requireStaff` answers it with `{error: 'Forbidden', message: 'This
 * operation requires Oxy platform staff privileges'}`, a body no handler and no
 * error middleware in this repo produces. Both are asserted.
 *
 * **The 403 is paired with a positive control on the SAME bearer.** `GET
 * /users/me` is `authMiddleware`-only, and the control asserts it comes back
 * 200 carrying that member's own account id — so the credential provably
 * authenticates, and "the fixture cannot log in" is excluded as an explanation
 * for the 403. Without it this suite would pass against a `/metrics` that had
 * simply been deleted.
 *
 * **The 200 case asserts the sensitive fields are really there.** A staff 200
 * over an empty body would satisfy a status-only check while proving nothing
 * about what the gate protects.
 *
 * ## What is real here
 *
 * Everything on the path. The suite imports the REAL `server.ts` — the same
 * mount, in the same order, with the real global middleware in front of it —
 * and drives it with bearers minted by the real `sessionService` against the
 * real Postgres, so `authMiddleware`, `validateSession` and the token binding
 * check all run. Nothing on the authorization path is mocked; a mocked
 * `authMiddleware` would populate `req.user` itself and this file would pass
 * against a deleted `requireStaff`.
 */

// The run-wide setup (`jest.setup.cjs`) replaces `socket.io` with a stub that
// has no `.use`, and importing the real `server.ts` attaches middleware to a
// real `Server`.
jest.unmock('socket.io');

// That same setup stubs `jsonwebtoken` so `sign` returns one constant string.
// This file mints TWO sessions and `sessions.access_token` is UNIQUE, so the
// second mint would collide — and two identical bearers could not tell a staff
// caller from a member in the first place.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

// `server.ts` runs `validateRequiredEnvVars()` at import and `process.exit(1)`s
// when anything is missing, which would take the whole jest worker with it. CI
// supplies these; a developer running `bun run test` without them does not.
// `??=` so a real value always wins — the mint below and the middleware's own
// verification must read the SAME secret.
process.env.ACCESS_TOKEN_SECRET ??= 'metrics-gate-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'metrics-gate-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'metrics-gate';
process.env.AWS_SECRET_ACCESS_KEY ??= 'metrics-gate';
process.env.AWS_S3_BUCKET ??= 'metrics-gate';

import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import sessionService from '../services/session.service';

/** Importing `server.ts` pulls in every route module and its schema. */
const SLOW_STEP_TIMEOUT_MS = 120_000;

/** The exact body `middleware/requireStaff.ts` answers with. */
const STAFF_REFUSAL = {
  error: 'Forbidden',
  message: 'This operation requires Oxy platform staff privileges',
};

let server: import('http').Server;
/** A platform staff member's bearer. */
let staffBearer = '';
/** An ordinary authenticated user's bearer, and the account it belongs to. */
let memberBearer = '';
let memberUserId = '';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function createUser(options: { isStaff: boolean }): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `metrics-gate-${randomUUID().slice(0, 12)}`,
      isStaff: options.isStaff,
    })
    .returning({ id: users.id });
  return row.id;
}

/** A bearer exactly as the device lane mints one for this account. */
async function bearerFor(userId: string): Promise<string> {
  const session = await sessionService.createSession(
    userId,
    { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never,
    { deviceId: randomUUID() }
  );
  const minted = await sessionService.getAccessToken(session.sessionId);
  if (!minted) {
    throw new Error('no access token for the freshly created session');
  }
  return minted.accessToken;
}

async function call(path: string, bearer?: string): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

beforeAll(async () => {
  await connectPostgres();
  server = (await import('../server')).default;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  staffBearer = await bearerFor(await createUser({ isStaff: true }));
  memberUserId = await createUser({ isStaff: false });
  memberBearer = await bearerFor(memberUserId);
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
}, SLOW_STEP_TIMEOUT_MS);

describe('GET /metrics', () => {
  it('refuses an unauthenticated caller with 401', async () => {
    const { status, body } = await call('/metrics');

    expect(status).toBe(401);
    // `authMiddleware`'s own missing-header branch, not `requireStaff`'s — the
    // two refusals must stay distinguishable, because a gate that answered 401
    // to a signed-in member would be indistinguishable from a broken bearer.
    expect(body.error).toBe('Authentication required');
  });

  it('refuses an authenticated NON-STAFF caller with 403, in `requireStaff`s own words', async () => {
    const { status, body } = await call('/metrics', memberBearer);

    // 403, asserted exactly. 401 here would mean the bearer never
    // authenticated and the gate was never reached; 404 or 500 would mean the
    // route is not the one under test.
    expect(status).toBe(403);
    expect(body).toEqual(STAFF_REFUSAL);
  });

  it('POSITIVE CONTROL: that same bearer is accepted on a route it is entitled to', async () => {
    // If this fails, the 403 above says nothing about authorization — an
    // unauthenticatable fixture produces the same refusal.
    const { status, body } = await call('/users/me', memberBearer);

    expect(status).toBe(200);
    // Not merely "some 200": the response is THIS member's own account, so the
    // bearer provably resolved to a user through the real `authMiddleware`.
    expect((body.data as { id?: string }).id).toBe(memberUserId);
  });

  it('serves a staff caller 200, with the fields the gate exists to withhold', async () => {
    const { status, body } = await call('/metrics', staffBearer);

    expect(status).toBe(200);

    // A staff 200 over an empty payload would pass a status-only assertion
    // while proving nothing about what non-staff callers no longer receive.
    const memory = body.memory as Record<string, unknown>;
    expect(typeof memory.rss).toBe('number');
    expect(typeof memory.heapUsed).toBe('number');

    // The infrastructure disclosure: the database endpoint's hostname and the
    // database name, parsed out of `DATABASE_URL`.
    const database = body.database as Record<string, unknown>;
    expect(typeof database.host).toBe('string');
    expect(typeof database.name).toBe('string');

    // The request-surface disclosure.
    const performance = body.performance as Record<string, unknown>;
    expect(performance.summary).toBeDefined();
    expect(Array.isArray(performance.slowOperations)).toBe(true);

    expect(new Date(String(body.timestamp)).toISOString()).toBe(body.timestamp);
  });
});
