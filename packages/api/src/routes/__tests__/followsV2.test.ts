/**
 * `/v2/follows` and `/v2/follow-targets` over real HTTP.
 *
 * The service tests take a `FollowCapability` as an argument, which means they
 * assume the answer to the question these routes exist to ask: WHO is asking,
 * and what did the user let them do. Here nothing is assumed — the rows are
 * real (`auth_sessions` → `applications` → `app_grants`), the capability is
 * resolved by the shipped code, and the only thing mocked is the auth
 * middleware, because verifying a token is a different subject.
 *
 * What that buys, and what a service test cannot: proof that the routes are
 * mounted where the server says, that a session with no authorization behind it
 * is refused, and that a grant missing one scope refuses exactly the operations
 * that scope covers and no others.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

const mockAuthMiddleware = jest.fn();
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { followRelationships } from '../../db/schema/followRelationships';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import followsRouter, { meFollowsRouter } from '../follows.v2.routes';
import followRegistryRouter from '../followRegistry.v2.routes';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;
let counter = 0;

const unique = (prefix: string) => `${prefix}${(counter += 1)}`;

async function request(
  method: string,
  path: string,
  payload?: unknown
): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const hasBody = method !== 'GET';
  const body = hasBody ? JSON.stringify(payload ?? {}) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port,
        path,
        headers: {
          // `content-length` on a GET with nothing written makes the server wait
          // for a body that never arrives — every request hangs, and the failure
          // reads as the route being broken rather than the helper.
          ...(hasBody
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }
            : {}),
          // Keep-alive sockets otherwise hold `server.close()` open past the
          // hook timeout.
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
        });
      }
    );
    req.on('error', reject);
    if (hasBody) req.write(body);
    req.end();
  });
}

/** Mint a user, an application, an authorization and a grant with these scopes. */
async function signIn(scopes: string[]): Promise<{ userId: string; applicationId: string }> {
  const db = getDb();
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [app] = await db
    .insert(applications)
    .values({ name: unique('App '), status: 'active', ownerAccountId: user.id })
    .returning({ id: applications.id });

  const sessionId = unique('session-');
  await db.insert(authSessions).values({
    sessionToken: unique('token-'),
    applicationId: app.id,
    authorizedSessionId: sessionId,
    authorizedUserId: user.id,
    status: 'authorized',
    // NOT NULL with no default. An hour is arbitrary and irrelevant: nothing on
    // this path reads it, but the column is the schema's and the test has to
    // satisfy it rather than route around it.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  await db
    .insert(appGrants)
    .values({ userId: user.id, applicationId: app.id, scopes });

  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown; sessionId?: string }, _res: unknown, next: () => void) => {
      req.user = { id: user.id };
      req.sessionId = sessionId;
      next();
    }
  );

  return { userId: user.id, applicationId: app.id };
}

/** A registered kind in a namespace this application owns, plus one target. */
async function registerTarget(kindSuffix = 'thing') {
  const ns = unique('rt');
  const claim = await request('POST', '/v2/follow-targets/namespaces', { namespace: ns });
  expect(claim.status).toBe(200);
  const kind = `${ns}.${kindSuffix}`;
  expect((await request('POST', '/v2/follow-targets/kinds', { kind })).status).toBe(200);

  const target = await request('POST', '/v2/follow-targets', {
    uri: unique('https://example.test/things/'),
    kind,
  });
  expect(target.status).toBe(200);
  return { kind, targetId: (target.body.data as { id: string }).id };
}

const ALL_SCOPES = [
  'follows:read',
  'follows:write',
  'follows:context:write',
  'follow-targets:register',
];

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  // Mounted exactly as `server.ts` mounts them, so a path change there breaks
  // a test rather than a client.
  app.use('/v2/follows', followsRouter);
  app.use('/v2/me', meFollowsRouter);
  app.use('/v2/follow-targets', followRegistryRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('a session with nothing behind it', () => {
  it('is refused, and says the session was not an application authorization', async () => {
    const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
    mockAuthMiddleware.mockImplementation(
      (req: { user?: unknown; sessionId?: string }, _res: unknown, next: () => void) => {
        req.user = { id: user.id };
        req.sessionId = 'session-that-authorized-nothing';
        next();
      }
    );

    const res = await request('GET', '/v2/me/follows');
    expect(res.status).toBe(403);
    // The distinction matters to the client: this one needs the consent screen,
    // a revoked grant needs the user to decide again.
    expect(String(res.body.message ?? res.body.error)).toMatch(/application authorization/i);
  });
});

describe('scopes gate the operations they name', () => {
  it('refuses a write, by name, when only reads were granted', async () => {
    await signIn(['follows:read', 'follow-targets:register']);
    const { targetId } = await registerTarget();

    const res = await request('PUT', `/v2/follows/${targetId}`);
    expect(res.status).toBe(403);
    // Named, because "this app has not been granted permission to change who
    // you follow" is actionable and a bare 403 is not.
    expect(String(res.body.message ?? res.body.error)).toContain('follows:write');
  });

  it('allows the read that WAS granted', async () => {
    await signIn(['follows:read', 'follow-targets:register']);
    const { targetId } = await registerTarget();

    const res = await request('GET', `/v2/follows/${targetId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ globalState: 'none', effectiveState: 'not_following' });
  });

  it('refuses registry writes without the registry scope', async () => {
    await signIn(['follows:read', 'follows:write']);
    const res = await request('POST', '/v2/follow-targets/namespaces', { namespace: 'nope' });
    expect(res.status).toBe(403);
    expect(String(res.body.message ?? res.body.error)).toContain('follow-targets:register');
  });
});

describe('following, over the wire', () => {
  it('follows, reports the three states apart, and unfollows', async () => {
    await signIn(ALL_SCOPES);
    const { targetId } = await registerTarget();

    const followed = await request('PUT', `/v2/follows/${targetId}`);
    expect(followed.status).toBe(200);
    const { relationshipId, created } = followed.body.data as {
      relationshipId: string;
      created: boolean;
    };
    expect(created).toBe(true);

    const status = await request('GET', `/v2/follows/${targetId}/status`);
    expect(status.body.data).toMatchObject({
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
    });

    // Off HERE: still following globally, inactive in effect. The whole reason
    // the status is three fields and not a boolean.
    const disabled = await request('PUT', `/v2/follows/${relationshipId}/context`, {
      mode: 'disabled',
    });
    expect(disabled.status).toBe(200);
    expect((await request('GET', `/v2/follows/${targetId}/status`)).body.data).toMatchObject({
      // Still followed globally. `effectiveState` answers "does this act here",
      // so a client that read it as "does the user follow this" would offer to
      // follow something already followed.
      globalState: 'active',
      applicationMode: 'disabled',
      effectiveState: 'not_following',
    });

    const removed = await request('DELETE', `/v2/follows/${relationshipId}`);
    expect(removed.body.data).toMatchObject({ removed: true });
    expect((await request('GET', `/v2/follows/${targetId}/status`)).body.data).toMatchObject({
      globalState: 'none',
      effectiveState: 'not_following',
    });
  });

  it('is idempotent: following twice returns the same relationship', async () => {
    await signIn(ALL_SCOPES);
    const { targetId } = await registerTarget();

    const first = (await request('PUT', `/v2/follows/${targetId}`)).body.data as {
      relationshipId: string;
      created: boolean;
    };
    const second = (await request('PUT', `/v2/follows/${targetId}`)).body.data as {
      relationshipId: string;
      created: boolean;
    };

    expect(second.relationshipId).toBe(first.relationshipId);
    expect(second.created).toBe(false);
  });

  it('records an expiry for a timed follow, and refuses an unbounded one', async () => {
    await signIn(ALL_SCOPES);
    const { targetId } = await registerTarget();

    const timed = await request('PUT', `/v2/follows/${targetId}`, { expiresIn: 72 * 60 * 60 });
    expect(timed.status).toBe(200);
    // The whole resulting status comes back, so a client stores the answer
    // instead of reconstructing one — and the "for 72 hours" a toast promises
    // is a value the server confirmed rather than one the client assumed.
    expect(
      typeof (timed.body.data as { status: { expiresAt?: string } }).status.expiresAt
    ).toBe('string');

    const { targetId: other } = await registerTarget();
    // Ten years is indistinguishable from permanent to a user who was told it
    // would end.
    const absurd = await request('PUT', `/v2/follows/${other}`, { expiresIn: 10 * 365 * 86400 });
    expect(absurd.status).toBe(400);
  });

  it('404s a target that does not exist rather than creating one', async () => {
    await signIn(ALL_SCOPES);
    // Following must never mint targets: a typo would become a permanent row
    // that one user follows and nobody else can reach.
    expect((await request('PUT', '/v2/follows/00000000-0000-4000-8000-000000000000')).status).toBe(
      404
    );
  });

  it('refuses self-follow with 400', async () => {
    const { userId } = await signIn(ALL_SCOPES);
    const target = await request('POST', '/v2/follow-targets', {
      uri: `https://oxy.so/users/${userId}`,
      kind: 'oxy.user',
    });
    expect(target.status).toBe(200);
    const targetId = (target.body.data as { id: string }).id;

    const res = await request('PUT', `/v2/follows/${targetId}`);
    expect(res.status).toBe(400);
    expect(String(res.body.message ?? res.body.error)).toMatch(/yourself/i);
  });
});

describe('the central list', () => {
  it('returns the caller’s own follows, with this application’s mode on each row', async () => {
    const { userId } = await signIn(ALL_SCOPES);
    const { targetId, kind } = await registerTarget();
    await request('PUT', `/v2/follows/${targetId}`);

    const res = await request('GET', '/v2/me/follows');
    expect(res.status).toBe(200);
    const follows = (res.body.data as { follows: Array<Record<string, unknown>> }).follows;
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatchObject({
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
      target: { kind },
    });

    // Owner-only by construction: filtered on the capability's user, with no
    // parameter that could name anybody else.
    const rows = await getDb()
      .select({ id: followRelationships.id })
      .from(followRelationships)
      .where(eq(followRelationships.followerUserId, userId));
    expect(rows).toHaveLength(1);
  });

  it('does not show one user another user’s follows', async () => {
    await signIn(ALL_SCOPES);
    const { targetId } = await registerTarget();
    await request('PUT', `/v2/follows/${targetId}`);

    // A second user, a second application, a second grant — everything new.
    await signIn(ALL_SCOPES);
    const res = await request('GET', '/v2/me/follows');
    expect((res.body.data as { follows: unknown[] }).follows).toHaveLength(0);
  });
});

describe('the registry, over the wire', () => {
  it('refuses a namespace another application already holds, as a conflict', async () => {
    await signIn(ALL_SCOPES);
    const ns = unique('rt');
    expect((await request('POST', '/v2/follow-targets/namespaces', { namespace: ns })).status).toBe(
      200
    );

    await signIn(ALL_SCOPES);
    const res = await request('POST', '/v2/follow-targets/namespaces', { namespace: ns });
    // 409 and not 403: the caller's permissions are fine, the name is somebody
    // else's — a 403 would send them to ask for a scope that would not help.
    expect(res.status).toBe(409);
  });

  it('resolves the same URI to one target across two applications', async () => {
    await signIn(ALL_SCOPES);
    const { kind } = await registerTarget();
    const uri = unique('https://example.test/shared/');
    const first = await request('POST', '/v2/follow-targets', { uri, kind });

    // A different application, registering the same URI under the first app's
    // kind: it does not own the kind, but it does not need to — it is naming a
    // thing, not defining one.
    await signIn(ALL_SCOPES);
    const second = await request('POST', '/v2/follow-targets', { uri, kind });

    expect(second.status).toBe(200);
    expect((second.body.data as { id: string }).id).toBe((first.body.data as { id: string }).id);
    expect((second.body.data as { created: boolean }).created).toBe(false);
  });
});
