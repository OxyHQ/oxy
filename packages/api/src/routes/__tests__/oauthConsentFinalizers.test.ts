/**
 * Both OAuth finalizers, side by side, against a REAL Postgres (issue #1521).
 *
 * `POST /auth/oauth/authorize` and `POST /auth/session/finalize/:sessionToken`
 * both turn an approved authorization into a code. They used to decide and
 * persist consent separately — and disagree — and both minted the code before a
 * best-effort grant write that swallowed its own failure. They now share
 * `oauthConsent.service.ts`, and this file holds them to it:
 *
 *  - the same request leaves the SAME state on either entry, for a first-party
 *    app with an ordinary scope, a first-party app with a consent-required
 *    scope, and a third-party app;
 *  - a revocation survives an ordinary first-party sign-in on either entry, and
 *    only an explicit, carried `acting-as:offline` undoes it;
 *  - a write that cannot be stored leaves NO code and NO grant behind;
 *  - a code is redeemable once;
 *  - concurrent retries converge on one grant (and, for a request, one code).
 *
 * Nothing on the persistence path is mocked: `issueAuthCode` writes real
 * `auth_codes` rows, and failures are injected as real Postgres errors by a
 * trigger, so the transaction under test is the one production runs.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const bearerSessionIds = new Map<string, string>();
let authenticatedUser: { _id: string; username?: string } | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown; sessionId?: string },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = authenticatedUser;
    req.sessionId = bearerSessionIds.get(authenticatedUser._id);
    next();
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => null,
  decodeToken: () => null,
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getAccessToken: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({ broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { authCodes } from '../../db/schema/authCodes';
import { authSessions } from '../../db/schema/authSessions';
import { serviceActingAsRevocations } from '../../db/schema/serviceActingAsRevocations';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { insertBearerSession } from '../__fixtures__/bearerSessionFixtures';
import { exchangeAuthCode } from '../../services/oauthCode.service';
import { resolveServiceActingAsGrant } from '../../services/serviceActingAs.service';
import authRouter from '../auth';
import { USER_CONSENT_REQUIRED_SCOPES } from '../../utils/applicationScopes';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const REDIRECT = 'https://app.example.com/callback';

let server: http.Server;

function post(path: string, body: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  bearerSessionIds.set(row.id, await insertBearerSession(row.id));
  return row.id;
}

interface Client {
  clientId: string;
  applicationId: string;
}

async function client(appFields: Partial<typeof applications.$inferInsert> = {}): Promise<Client> {
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      scopes: ['user:read', 'files:read'],
      redirectUris: [REDIRECT],
      ...appFields,
      ownerAccountId: await account(),
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    publicKey: clientId,
    type: 'public',
    environment: 'production',
  });
  return { clientId, applicationId: app.id };
}

/** A PKCE pair: the verifier the client keeps, the S256 challenge it sends. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

type Entry = 'authorize' | 'finalize';

interface Finalized {
  status: number;
  error?: unknown;
  code?: string;
  /** The PKCE verifier for redeeming `code`. */
  verifier: string;
  /** For the `finalize` entry, the request row that was finalized. */
  authSessionId?: string;
}

/** `POST /auth/oauth/authorize` as `userId`, the auth UI's consent screen. */
async function viaAuthorize(userId: string, app: Client, scope: string): Promise<Finalized> {
  const { verifier, challenge } = pkce();
  authenticatedUser = { _id: userId };
  const res = await post('/auth/oauth/authorize', {
    clientId: app.clientId,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    ...(scope ? { scope } : {}),
  });
  const data = res.body.data as { code?: string } | undefined;
  return { status: res.status, code: data?.code, verifier, error: res.body.error };
}

/** An OAuth-bound request approved by `userId`, ready to finalize. */
async function approvedRequest(
  userId: string,
  app: Client,
  scopes: string[],
): Promise<{ sessionToken: string; id: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const sessionToken = `st-${randomUUID()}`;
  const [row] = await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode: `ac-${randomUUID()}`,
      applicationId: app.applicationId,
      originVerified: true,
      boundOrigin: 'https://app.example.com',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      purpose: 'oauth_authorization',
      oauthRedirectUri: REDIRECT,
      oauthCodeChallenge: challenge,
      oauthCodeChallengeMethod: 'S256',
      oauthScopes: scopes,
      status: 'authorized',
      authorizedUserId: userId,
    })
    .returning({ id: authSessions.id });
  return { sessionToken, id: row.id, verifier };
}

/** `POST /auth/session/finalize/:sessionToken` for an approved request. */
async function viaFinalize(userId: string, app: Client, scope: string): Promise<Finalized> {
  const request = await approvedRequest(userId, app, scope ? scope.split(' ') : []);
  const res = await post(`/auth/session/finalize/${request.sessionToken}`, {});
  const data = res.body.data as { code?: string } | undefined;
  return { status: res.status, code: data?.code, verifier: request.verifier, authSessionId: request.id, error: res.body.error };
}

function finalizeWith(entry: Entry): typeof viaAuthorize {
  return entry === 'authorize' ? viaAuthorize : viaFinalize;
}

async function storedGrant(userId: string, applicationId: string) {
  const [row] = await getDb()
    .select()
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
    .limit(1);
  return row;
}

async function hasRevocation(userId: string, applicationId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: serviceActingAsRevocations.id })
    .from(serviceActingAsRevocations)
    .where(
      and(
        eq(serviceActingAsRevocations.userId, userId),
        eq(serviceActingAsRevocations.applicationId, applicationId),
      ),
    );
  return rows.length > 0;
}

async function codesFor(userId: string, applicationId: string) {
  return getDb()
    .select({ id: authCodes.id, scopes: authCodes.scopes })
    .from(authCodes)
    .where(and(eq(authCodes.userId, userId), eq(authCodes.applicationId, applicationId)));
}

/** Everything an authorization leaves behind for one user and application. */
async function stateOf(userId: string, applicationId: string) {
  const grant = await storedGrant(userId, applicationId);
  const codes = await codesFor(userId, applicationId);
  return {
    grantScopes: grant ? [...grant.scopes] : null,
    revoked: await hasRevocation(userId, applicationId),
    codeScopes: codes.map((c) => [...c.scopes]),
    actingAs: (await resolveServiceActingAsGrant(applicationId, userId)).authorized,
  };
}

/** The user-facing revoke: delete the grant and write the refusal marker. */
async function revoke(userId: string, applicationId: string): Promise<void> {
  await getDb()
    .delete(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)));
  await getDb().insert(serviceActingAsRevocations).values({ userId, applicationId });
}

/**
 * Make every write to `table` for `applicationId` fail with a real Postgres
 * error for the duration of `run`. The trigger is always dropped — this worker's
 * database is shared with the suites that run after this file.
 */
async function withFailingWrites<T>(
  table: 'app_grants' | 'auth_codes',
  applicationId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/.test(applicationId)) {
    throw new Error(`unexpected application id ${applicationId}`);
  }
  const fn = `i02_fail_${table}`;
  await getDb().execute(
    sql.raw(`create or replace function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.application_id = '${applicationId}' then
          raise exception 'injected ${table} failure';
        end if;
        return new;
      end $$`),
  );
  await getDb().execute(
    sql.raw(`create trigger ${fn} before insert or update on ${table}
      for each row execute function ${fn}()`),
  );
  try {
    return await run();
  } finally {
    await getDb().execute(sql.raw(`drop trigger if exists ${fn} on ${table}`));
    await getDb().execute(sql.raw(`drop function if exists ${fn}()`));
  }
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  authenticatedUser = null;
});

const ENTRIES: Entry[] = ['authorize', 'finalize'];

/**
 * The matrix the issue names. Each row runs on BOTH entries, for two different
 * users, and the two resulting states must be identical — and equal to what the
 * row expects, so "both entries agree" can never be satisfied by both being
 * wrong the same way.
 */
describe('both entries leave the same state for the same request', () => {
  const MATRIX: Array<{
    name: string;
    app: Partial<typeof applications.$inferInsert>;
    scope: string;
    expected: Awaited<ReturnType<typeof stateOf>>;
  }> = [
    {
      name: 'first-party app, ordinary scope — authorized natively, no grant',
      app: { type: 'first_party', scopes: ['user:read', 'files:read'] },
      scope: 'user:read',
      expected: { grantScopes: null, revoked: false, codeScopes: [['user:read']], actingAs: false },
    },
    {
      name: 'first-party app, consent-required scope — a revocable grant',
      app: { type: 'first_party', scopes: ['user:read', 'acting-as:offline'] },
      scope: 'user:read acting-as:offline',
      expected: {
        grantScopes: ['user:read', 'acting-as:offline'],
        revoked: false,
        codeScopes: [['user:read', 'acting-as:offline']],
        actingAs: true,
      },
    },
    {
      name: 'third-party app — always a grant',
      app: { type: 'third_party', scopes: ['user:read', 'files:read'] },
      scope: 'user:read',
      expected: {
        grantScopes: ['user:read'],
        revoked: false,
        codeScopes: [['user:read']],
        actingAs: false,
      },
    },
  ];

  it.each(MATRIX)('$name', async ({ app: appFields, scope, expected }) => {
    const app = await client(appFields);
    const states = [];
    for (const entry of ENTRIES) {
      const userId = await account();
      const result = await finalizeWith(entry)(userId, app, scope);
      expect(result.status).toBe(200);
      expect(result.code).toEqual(expect.any(String));
      states.push(await stateOf(userId, app.applicationId));
    }
    expect(states[0]).toEqual(expected);
    expect(states[1]).toEqual(states[0]);
  });
});

/**
 * Revoke, sign in again, still revoked — on BOTH entries. Only a fresh,
 * explicit authorization of `acting-as:offline` undoes the refusal.
 */
describe('a revocation survives a first-party sign-in on either entry', () => {
  const ACTING_APP = { type: 'first_party' as const, scopes: ['user:read', 'acting-as:offline'] };

  it.each(ENTRIES)('%s: an ordinary first-party sign-in leaves it revoked', async (entry) => {
    const app = await client(ACTING_APP);
    const userId = await account();
    await finalizeWith(entry)(userId, app, 'user:read acting-as:offline');
    await revoke(userId, app.applicationId);

    const result = await finalizeWith(entry)(userId, app, 'user:read');

    expect(result.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: null,
      revoked: true,
      actingAs: false,
    });
  });

  it('finalize: a request that named NO scopes cannot undo it through the fallback set', async () => {
    // The approved fallback carries ordinary scopes only. Mandatory consent
    // cannot be inferred from trust, and an earlier refusal stays in force.
    const app = await client(ACTING_APP);
    const userId = await account();
    await revoke(userId, app.applicationId);

    const result = await viaFinalize(userId, app, '');

    expect(result.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toEqual({
      grantScopes: null,
      revoked: true,
      codeScopes: [['user:read']],
      actingAs: false,
    });
  });

  it.each(ENTRIES)('%s: an explicit acting-as:offline authorization restores it', async (entry) => {
    const app = await client(ACTING_APP);
    const userId = await account();
    await revoke(userId, app.applicationId);

    const result = await finalizeWith(entry)(userId, app, 'user:read acting-as:offline');

    expect(result.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: ['user:read', 'acting-as:offline'],
      revoked: false,
      actingAs: true,
    });
  });

  it('finalize: naming acting-as:offline for an app NOT registered for it restores nothing', async () => {
    // The code is intersected with the registered set, so the scope is dropped —
    // and a scope the code does not carry cannot have been consented to here.
    const app = await client({ type: 'first_party', scopes: ['user:read'] });
    const userId = await account();
    await revoke(userId, app.applicationId);

    expect((await viaFinalize(userId, app, 'user:read acting-as:offline')).status).toBe(200);

    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: null,
      revoked: true,
      actingAs: false,
    });
  });
});

/**
 * A write that cannot be stored hands out nothing usable. Each failure is a real
 * Postgres error raised inside the transaction, not a mocked rejection.
 */
/** `GET /auth/oauth/consent` as `userId` — whether the screen must ask, and about what. */
function getConsent(userId: string, app: Client, scope: string): Promise<JsonResponse> {
  authenticatedUser = { _id: userId };
  const address = server.address() as AddressInfo;
  const query = new URLSearchParams({ clientId: app.clientId, redirectUri: REDIRECT, scope });
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: address.port, path: `/auth/oauth/consent?${query}` }, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      })
      .on('error', reject);
  });
}

/**
 * The application's registered scopes are a ceiling neither entry can exceed:
 * a scope the platform never gave the app reaches neither the code nor the
 * consent row, whatever the request named, and the consent screen never offers
 * it. Only the application's registration can widen that ceiling.
 */
describe('a request cannot exceed the scopes the application is registered for', () => {
  it.each(ENTRIES)(
    '%s: a third party not registered for acting-as:offline cannot obtain it',
    async (entry) => {
      const app = await client({ type: 'third_party', scopes: ['user:read'] });
      const userId = await account();

      const result = await finalizeWith(entry)(userId, app, 'user:read acting-as:offline');

      expect(result.status).toBe(200);
      expect(await stateOf(userId, app.applicationId)).toEqual({
        grantScopes: ['user:read'],
        revoked: false,
        codeScopes: [['user:read']],
        actingAs: false,
      });
    },
  );

  it.each(ENTRIES)(
    '%s: a first party not registered for acting-as:offline gets the ordinary sign-in, no grant',
    async (entry) => {
      const app = await client({ type: 'first_party', scopes: ['user:read'] });
      const userId = await account();

      const result = await finalizeWith(entry)(userId, app, 'user:read acting-as:offline');

      expect(result.status).toBe(200);
      expect(await stateOf(userId, app.applicationId)).toEqual({
        grantScopes: null,
        revoked: false,
        codeScopes: [['user:read']],
        actingAs: false,
      });
    },
  );

  it('consent: the screen never asks about a scope the third party is not registered for', async () => {
    const app = await client({ type: 'third_party', scopes: ['user:read'] });
    const userId = await account();

    const res = await getConsent(userId, app, 'user:read acting-as:offline');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ consentRequired: true, reason: 'new' });
  });

  it('consent: a registered consent-required scope is still asked about', async () => {
    const app = await client({ type: 'third_party', scopes: ['user:read', 'acting-as:offline'] });
    const userId = await account();

    const res = await getConsent(userId, app, 'user:read acting-as:offline');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      consentRequired: true,
      reason: 'new',
      userConsentScopes: ['acting-as:offline'],
    });
  });

  it('consent: a grant covering every grantable scope is not asked again for one the app lacks', async () => {
    const app = await client({ type: 'third_party', scopes: ['user:read'] });
    const userId = await account();
    expect((await viaAuthorize(userId, app, 'user:read')).status).toBe(200);

    const res = await getConsent(userId, app, 'user:read acting-as:offline');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ consentRequired: false, reason: 'granted' });
  });
});

describe('a persistence failure leaves no code and no grant', () => {
  it('authorize: a grant that cannot be stored fails the request — no code is issued', async () => {
    const app = await client();
    const userId = await account();

    const result = await withFailingWrites('app_grants', app.applicationId, () =>
      viaAuthorize(userId, app, 'user:read'),
    );

    expect(result.status).toBe(500);
    expect(result.code).toBeUndefined();
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: null,
      codeScopes: [],
    });
  });

  it('finalize: a grant that cannot be stored mints nothing, and the spent request stays spent', async () => {
    const app = await client();
    const userId = await account();
    const request = await approvedRequest(userId, app, ['user:read']);

    const res = await withFailingWrites('app_grants', app.applicationId, () =>
      post(`/auth/session/finalize/${request.sessionToken}`, {}),
    );

    expect(res.status).toBe(401);
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: null,
      codeScopes: [],
    });
    // Fail closed: the request cannot be retried into a second minting attempt.
    const [row] = await getDb()
      .select({ status: authSessions.status })
      .from(authSessions)
      .where(eq(authSessions.id, request.id));
    expect(row.status).toBe('consumed');
    expect((await post(`/auth/session/finalize/${request.sessionToken}`, {})).status).toBe(401);
    expect(await codesFor(userId, app.applicationId)).toHaveLength(0);
  });

  it.each(ENTRIES)(
    '%s: a code that cannot be stored rolls back the grant AND the revocation clear',
    async (entry) => {
      // The order inside the transaction writes the grant and clears the refusal
      // BEFORE the code. Without the transaction, this failure would leave
      // acting-as authorized with no code ever issued.
      const app = await client({ type: 'first_party', scopes: ['user:read', 'acting-as:offline'] });
      const userId = await account();
      await revoke(userId, app.applicationId);

      const result = await withFailingWrites('auth_codes', app.applicationId, () =>
        finalizeWith(entry)(userId, app, 'user:read acting-as:offline'),
      );

      expect(result.status).toBe(entry === 'authorize' ? 500 : 401);
      expect(result.code).toBeUndefined();
      expect(await stateOf(userId, app.applicationId)).toEqual({
        grantScopes: null,
        revoked: true,
        codeScopes: [],
        actingAs: false,
      });
    },
  );

  it('authorize: recovery is a fresh authorization once storage is back', async () => {
    const app = await client();
    const userId = await account();
    await withFailingWrites('app_grants', app.applicationId, () =>
      viaAuthorize(userId, app, 'user:read'),
    );

    const retry = await viaAuthorize(userId, app, 'user:read');

    expect(retry.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: ['user:read'],
      codeScopes: [['user:read']],
    });
  });
});

describe('replay and concurrency', () => {
  it.each(ENTRIES)('%s: a code is redeemed exactly once', async (entry) => {
    const app = await client();
    const userId = await account();
    const result = await finalizeWith(entry)(userId, app, 'user:read');
    const redeem = () =>
      exchangeAuthCode({
        rawCode: result.code ?? '',
        appId: app.applicationId,
        redirectUri: REDIRECT,
        codeVerifier: result.verifier,
      });

    expect((await redeem()).ok).toBe(true);
    expect(await redeem()).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('authorize: concurrent retries converge on ONE grant, and every code they issued has it', async () => {
    // The direct entry has no request identity — each call is its own
    // authorization and gets its own single-use code. What must not happen is a
    // duplicate grant, a duplicated scope, or a code whose consent is missing.
    const app = await client();
    const userId = await account();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => viaAuthorize(userId, app, 'user:read files:read')),
    );

    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const grants = await getDb()
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, app.applicationId)));
    expect(grants).toHaveLength(1);
    expect(grants[0].scopes).toEqual(['user:read', 'files:read']);
    expect(await codesFor(userId, app.applicationId)).toHaveLength(6);
  });

  it('finalize: concurrent finalizations of one request mint ONE code and ONE grant', async () => {
    const app = await client();
    const userId = await account();
    const request = await approvedRequest(userId, app, ['user:read']);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post(`/auth/session/finalize/${request.sessionToken}`, {})),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 401)).toHaveLength(5);
    expect(await stateOf(userId, app.applicationId)).toMatchObject({
      grantScopes: ['user:read'],
      codeScopes: [['user:read']],
    });
  });

  it('a retried scope is never duplicated, and firstGrantedAt keeps when consent began', async () => {
    const app = await client();
    const userId = await account();
    await viaAuthorize(userId, app, 'user:read user:read');
    const first = await storedGrant(userId, app.applicationId);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await getDb().update(appGrants).set({ firstGrantedAt: past }).where(eq(appGrants.id, first.id));

    await viaFinalize(userId, app, 'files:read user:read');

    const after = await storedGrant(userId, app.applicationId);
    expect(after.id).toBe(first.id);
    expect(after.scopes).toEqual(['user:read', 'files:read']);
    expect(after.firstGrantedAt.getTime()).toBe(past.getTime());
  });
});

// Approved policy: trusted fallback is ordinary-only; third parties name scopes.
describe('explicit consent and restricted empty-scope fallback', () => {
  it.each([
    ['first_party', false, false], ['first_party', false, true],
    ['first_party', true, false], ['first_party', true, true],
    ['third_party', false, false], ['third_party', false, true],
    ['third_party', true, false], ['third_party', true, true],
  ] as const)('%s explicit=%s revoked=%s', async (type, explicit, revoked) => {
    const app = await client({ type, scopes: ['user:read', 'acting-as:offline'] });
    for (const entry of ENTRIES) {
      const userId = await account();
      if (revoked) await revoke(userId, app.applicationId);
      const result = await finalizeWith(entry)(userId, app,
        explicit ? 'user:read acting-as:offline' : '');
      const denied = type === 'third_party' && !explicit;
      expect(result.status).toBe(denied ? 400 : 200);
      if (denied) expect(result.error).toBe('invalid_scope');
      const state = await stateOf(userId, app.applicationId);
      const codeScopes = explicit ? ['user:read', 'acting-as:offline'] : ['user:read'];
      expect(state.codeScopes).toEqual(denied ? [] : [codeScopes]);
      expect(state.revoked).toBe(revoked && !explicit);
      expect(state.grantScopes).toEqual(explicit ? codeScopes : null);
      expect(state.actingAs).toBe(explicit);
    }
  });
});


describe('empty scopes cannot silently consent at any OAuth entry', () => {
  it.each(['first_party', 'third_party'] as const)('consent screen: %s', async (type) => {
    const app = await client({ type, scopes: ['user:read', ...USER_CONSENT_REQUIRED_SCOPES] });
    const userId = await account();
    const result = await getConsent(userId, app, '');
    expect(result.status).toBe(type === 'third_party' ? 400 : 200);
    if (type === 'third_party') expect(result.body.error).toBe('invalid_scope');
    else expect(result.body.data).toEqual({ consentRequired: false, reason: 'trusted' });
  });

  it.each(ENTRIES)('%s: trusted fallback excludes ALL consent-required scopes', async (entry) => {
    const app = await client({ type: 'first_party', scopes: ['user:read', ...USER_CONSENT_REQUIRED_SCOPES] });
    const userId = await account();
    const result = await finalizeWith(entry)(userId, app, '');
    expect(result.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toEqual({
      grantScopes: null, revoked: false, codeScopes: [['user:read']], actingAs: false,
    });
  });

  it('rejects a third-party empty request before persisting an AuthSession', async () => {
    const app = await client();
    const { challenge } = pkce();
    const result = await post('/auth/session/create', {
      sessionToken: randomBytes(32).toString('hex'),
      clientId: app.clientId,
      oauth: { redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256' },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_scope');
    const rows = await getDb().select({ id: authSessions.id }).from(authSessions)
      .where(eq(authSessions.applicationId, app.applicationId));
    expect(rows).toEqual([]);
  });
});


describe('explicit but unregistered scopes never become a fallback', () => {
  it.each(ENTRIES)('%s', async (entry) => {
    const app = await client({ type: 'first_party', scopes: ['user:read', 'acting-as:offline'] });
    const userId = await account();
    await revoke(userId, app.applicationId);
    const result = await finalizeWith(entry)(userId, app, 'unknown:permission');
    expect(result.status).toBe(200);
    expect(await stateOf(userId, app.applicationId)).toEqual({
      grantScopes: null, revoked: true, codeScopes: [[]], actingAs: false,
    });
  });
});
