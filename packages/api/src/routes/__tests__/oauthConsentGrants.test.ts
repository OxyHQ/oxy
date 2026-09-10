/**
 * OAuth consent and the "Connected apps" surface, against a REAL Postgres.
 *
 * Covers `GET /auth/oauth/consent` (the server-authoritative decision),
 * `GET /auth/grants` (the revocable grant list), `DELETE /auth/grants/:id`, and
 * the `app_grants` upsert that `POST /auth/oauth/authorize` performs — the
 * replacement for Mongo's `$addToSet` + `$setOnInsert`, whose UNION and
 * first-granted-at semantics are the whole reason a returning user can skip the
 * consent screen safely.
 *
 * The previous version mocked `models/AppGrant` and asserted on the
 * `findOneAndUpdate` payload shape. That proves the update was BUILT with
 * `$addToSet`; it can never show that the stored scope set is the union. Every
 * assertion here reads `app_grants` back out of Postgres.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockIssueAuthCode = jest.fn();

let authenticatedUser: { _id: string; username?: string } | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = authenticatedUser;
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
jest.mock('../../services/oauthCode.service', () => {
  const actual = jest.requireActual<typeof import('../../services/oauthCode.service')>(
    '../../services/oauthCode.service',
  );
  return {
    ...actual,
    issueAuthCode: (...args: unknown[]) => mockIssueAuthCode(...args),
    exchangeAuthCode: jest.fn(),
  };
});
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

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { serviceActingAsRevocations } from '../../db/schema/serviceActingAsRevocations';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { resolveServiceActingAsGrant } from '../../services/serviceActingAs.service';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const REDIRECT = 'https://app.example.com/callback';

let server: http.Server;

function send(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function client(
  appFields: Partial<typeof applications.$inferInsert> = {},
): Promise<{ clientId: string; applicationId: string }> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      scopes: ['user:read', 'files:read'],
      redirectUris: [REDIRECT],
      ...appFields,
      ownerAccountId: owner.id,
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

async function storedRevocation(userId: string, applicationId: string) {
  const [row] = await getDb()
    .select()
    .from(serviceActingAsRevocations)
    .where(
      and(
        eq(serviceActingAsRevocations.userId, userId),
        eq(serviceActingAsRevocations.applicationId, applicationId)
      )
    )
    .limit(1);
  return row;
}

async function storedGrant(userId: string, applicationId: string) {
  const [row] = await getDb()
    .select()
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
    .limit(1);
  return row;
}

function consentUrl(clientId: string, scope?: string): string {
  const params = new URLSearchParams({ clientId, redirectUri: REDIRECT });
  if (scope) params.set('scope', scope);
  return `/auth/oauth/consent?${params.toString()}`;
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

beforeEach(async () => {
  jest.clearAllMocks();
  mockIssueAuthCode.mockResolvedValue({ code: 'raw-code', expiresAt: new Date() });
  const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
  authenticatedUser = { _id: user.id, username: 'nate' };
});

describe('GET /auth/oauth/consent', () => {
  it('auto-approves a TRUSTED app regardless of scopes', async () => {
    const { clientId } = await client({ isOfficial: true });

    const res = await send('GET', consentUrl(clientId, 'user:read files:read'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ consentRequired: false, reason: 'trusted' });
  });

  it('requires consent for a third-party app with no prior grant', async () => {
    const { clientId } = await client();

    const res = await send('GET', consentUrl(clientId, 'user:read'));

    expect(res.body.data).toEqual({ consentRequired: true, reason: 'new' });
  });

  it('skips consent when a prior grant COVERS the requested scopes', async () => {
    const { clientId, applicationId } = await client();
    await getDb().insert(appGrants).values({
      userId: authenticatedUser?._id ?? '',
      applicationId,
      scopes: ['user:read', 'files:read'],
    });

    const res = await send('GET', consentUrl(clientId, 'user:read'));

    expect(res.body.data).toEqual({ consentRequired: false, reason: 'granted' });
  });

  it('requires consent again when a NEW scope is requested', async () => {
    const { clientId, applicationId } = await client();
    await getDb().insert(appGrants).values({
      userId: authenticatedUser?._id ?? '',
      applicationId,
      scopes: ['user:read'],
    });

    const res = await send('GET', consentUrl(clientId, 'user:read files:read'));

    expect(res.body.data).toEqual({ consentRequired: true, reason: 'scope_changed' });
  });

  it('reads only THIS user grant — another user consent never counts', async () => {
    const { clientId, applicationId } = await client();
    const [other] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb().insert(appGrants).values({
      userId: other.id,
      applicationId,
      scopes: ['user:read'],
    });

    const res = await send('GET', consentUrl(clientId, 'user:read'));

    expect(res.body.data).toEqual({ consentRequired: true, reason: 'new' });
  });

  it('rejects an unregistered redirect_uri with 403', async () => {
    const { clientId } = await client();
    const params = new URLSearchParams({
      clientId,
      redirectUri: 'https://evil.example/callback',
    });

    const res = await send('GET', `/auth/oauth/consent?${params.toString()}`);

    expect(res.status).toBe(403);
  });

  it('rejects an unknown client with 400', async () => {
    const res = await send('GET', consentUrl('oxy_dk_unknown'));
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/oauth/authorize — the recorded grant', () => {
  it('records a grant for a THIRD-PARTY app with the requested scopes', async () => {
    const { clientId, applicationId } = await client();

    const res = await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });

    expect(res.status).toBe(200);
    const grant = await storedGrant(authenticatedUser?._id ?? '', applicationId);
    expect(grant.scopes).toEqual(['user:read']);
    expect(grant.firstGrantedAt).toBeInstanceOf(Date);
    expect(grant.lastUsedAt).toBeInstanceOf(Date);
  });

  it('records NO grant for a TRUSTED app — those are auto-approved, not revocable', async () => {
    const { clientId, applicationId } = await client({ isOfficial: true });

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });

    expect(await storedGrant(authenticatedUser?._id ?? '', applicationId)).toBeUndefined();
  });

  it('UNIONS scopes across authorizations instead of replacing them', async () => {
    const { clientId, applicationId } = await client();

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });
    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'files:read',
    });

    const grant = await storedGrant(authenticatedUser?._id ?? '', applicationId);
    expect([...grant.scopes].sort()).toEqual(['files:read', 'user:read']);
  });

  it('never duplicates a scope already granted', async () => {
    const { clientId, applicationId } = await client();

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });
    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read user:read',
    });

    const grant = await storedGrant(authenticatedUser?._id ?? '', applicationId);
    expect(grant.scopes).toEqual(['user:read']);
  });

  it('preserves firstGrantedAt while refreshing lastUsedAt', async () => {
    const { clientId, applicationId } = await client();
    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });
    const original = await storedGrant(authenticatedUser?._id ?? '', applicationId);

    // Push `first_granted_at` into the past so a re-stamp would be visible.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await getDb()
      .update(appGrants)
      .set({ firstGrantedAt: past, lastUsedAt: past })
      .where(eq(appGrants.id, original.id));

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read',
    });

    const updated = await storedGrant(authenticatedUser?._id ?? '', applicationId);
    // `$setOnInsert` semantics: when the user FIRST consented is history.
    expect(updated.firstGrantedAt.getTime()).toBe(past.getTime());
    expect(updated.lastUsedAt.getTime()).toBeGreaterThan(past.getTime());
    // One row per (user, application) — the upsert never inserts a duplicate.
    expect(updated.id).toBe(original.id);
  });
});

describe('GET /auth/grants', () => {
  it('lists the user grants joined with the application name + logo, newest use first', async () => {
    const userId = authenticatedUser?._id ?? '';
    const first = await client({ name: 'Older App', icon: 'icon-older' });
    const second = await client({ name: 'Newer App', icon: 'icon-newer' });
    const older = new Date(Date.now() - 60 * 60 * 1000);
    await getDb().insert(appGrants).values([
      {
        userId,
        applicationId: first.applicationId,
        scopes: ['user:read'],
        firstGrantedAt: older,
        lastUsedAt: older,
      },
      { userId, applicationId: second.applicationId, scopes: ['files:read'] },
    ]);

    const res = await send('GET', '/auth/grants');

    expect(res.status).toBe(200);
    const data = res.body.data as Array<Record<string, unknown>>;
    expect(data.map((entry) => entry.applicationId)).toEqual([
      second.applicationId,
      first.applicationId,
    ]);
    expect(data[0]).toMatchObject({ name: 'Newer App', logoUrl: 'icon-newer', scopes: ['files:read'] });
    expect(typeof data[0].firstGrantedAt).toBe('string');
    expect(typeof data[0].lastUsedAt).toBe('string');
  });

  it('returns an empty list for a user with no grants', async () => {
    const res = await send('GET', '/auth/grants');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('never lists ANOTHER user grants', async () => {
    const { applicationId } = await client();
    const [other] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb().insert(appGrants).values({ userId: other.id, applicationId, scopes: [] });

    const res = await send('GET', '/auth/grants');

    expect(res.body.data).toEqual([]);
  });
});

describe('DELETE /auth/grants/:applicationId', () => {
  it('revokes the grant so the next authorize prompts for consent again', async () => {
    const userId = authenticatedUser?._id ?? '';
    const { clientId, applicationId } = await client();
    await getDb().insert(appGrants).values({ userId, applicationId, scopes: ['user:read'] });

    const res = await send('DELETE', `/auth/grants/${applicationId}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true });
    expect(await storedGrant(userId, applicationId)).toBeUndefined();
    const consent = await send('GET', consentUrl(clientId, 'user:read'));
    expect(consent.body.data).toEqual({ consentRequired: true, reason: 'new' });
  });

  it('never revokes ANOTHER user grant for the same application', async () => {
    const { applicationId } = await client();
    const [other] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb()
      .insert(appGrants)
      .values({ userId: other.id, applicationId, scopes: ['user:read'] });

    const res = await send('DELETE', `/auth/grants/${applicationId}`);

    expect(res.status).toBe(200);
    expect(await storedGrant(other.id, applicationId)).toBeDefined();
  });

  it('is idempotent when no grant exists', async () => {
    const { applicationId } = await client();
    const res = await send('DELETE', `/auth/grants/${applicationId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true });
  });

  it('answers the same way for an applicationId that names nothing', async () => {
    // The `isValidObjectId` guard is deleted — revoke is idempotent and total,
    // so a malformed id is indistinguishable from an id with no grant. Keeping
    // the guard would have 400'd every uuid v7 application id after the cutover.
    const res = await send('DELETE', '/auth/grants/not-an-id-at-all');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true });
  });
});

/*
 * The authority rule of the follow graph, as tests.
 *
 * The relationships are the USER's: other people can see them, and they outlive
 * whatever app created them. So platform trust — which answers "may this app
 * read its own files without asking?" — is not allowed to answer for them. An
 * official app and a third-party one must reach exactly the same outcome for the
 * same requested scopes, and the only thing that changes the outcome is what the
 * user granted.
 */
describe('follow scopes are never auto-approved, for anybody', () => {
  it('asks a TRUSTED app for consent, and names the scope that forced it', async () => {
    const { clientId } = await client({ isOfficial: true });

    const res = await send('GET', consentUrl(clientId, 'user:read follows:write'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      consentRequired: true,
      reason: 'new',
      userConsentScopes: ['follows:write'],
    });
  });

  it('still auto-approves that same trusted app for everything else', async () => {
    // The bypass is narrowed, not removed: an app reading its own files should
    // not start prompting because an unrelated scope family was added.
    const { clientId } = await client({ isOfficial: true });

    const res = await send('GET', consentUrl(clientId, 'user:read files:read'));

    expect(res.body.data).toEqual({ consentRequired: false, reason: 'trusted' });
  });

  it('gives an official and a third-party app the SAME answer for the same scopes', async () => {
    const official = await client({ isOfficial: true });
    const thirdParty = await client();

    const officialRes = await send('GET', consentUrl(official.clientId, 'follows:read'));
    const thirdPartyRes = await send('GET', consentUrl(thirdParty.clientId, 'follows:read'));

    expect(officialRes.body.data).toEqual(thirdPartyRes.body.data);
    expect(officialRes.body.data.consentRequired).toBe(true);
  });

  it('lets the USER\u2019s grant do the authorizing, for a trusted app too', async () => {
    // Once consented, the returning-user path applies as it does for anyone —
    // the grant is what authorizes, which is the whole claim being made here.
    const { clientId, applicationId } = await client({ isOfficial: true });
    await getDb().insert(appGrants).values({
      userId: authenticatedUser?._id ?? '',
      applicationId,
      scopes: ['follows:read'],
    });

    const res = await send('GET', consentUrl(clientId, 'follows:read'));

    expect(res.body.data).toEqual({ consentRequired: false, reason: 'granted' });
  });

  it('records a REVOCABLE grant when a trusted app is consented a follow scope', async () => {
    // A trusted app normally records none, because it never prompted. Here it
    // did prompt, and a permission the user granted but cannot find or withdraw
    // would be worse than one they were never asked for.
    const { clientId, applicationId } = await client({ isOfficial: true });

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read follows:write',
    });

    const grant = await storedGrant(authenticatedUser?._id ?? '', applicationId);
    expect(grant?.scopes).toEqual(['user:read', 'follows:write']);
  });
});

/**
 * Revoking removes explicit consent and records a positive refusal.
 *
 * The grant is the only positive authorization path, including for first-party
 * applications. The marker still matters: it wins over a stale or racing grant
 * and can only be cleared by a fresh `acting-as:offline` consent flow. These
 * tests assert against `resolveServiceActingAsGrant`, not storage alone.
 */
describe('DELETE /auth/grants/:applicationId — offline delegation', () => {
  it('revokes an explicit FIRST-PARTY grant and writes a refusal marker', async () => {
    const userId = authenticatedUser?._id ?? '';
    const { applicationId } = await client({
      type: 'first_party',
      scopes: ['user:read', 'acting-as:offline'],
    });
    await getDb().insert(appGrants).values({
      userId,
      applicationId,
      scopes: ['user:read', 'acting-as:offline'],
    });

    expect(await resolveServiceActingAsGrant(applicationId, userId)).toEqual({
      authorized: true,
      scopes: ['user:read', 'acting-as:offline'],
    });

    const res = await send('DELETE', `/auth/grants/${applicationId}`);

    expect(res.status).toBe(200);
    expect(await storedGrant(userId, applicationId)).toBeUndefined();
    expect(await storedRevocation(userId, applicationId)).toBeDefined();
    expect(await resolveServiceActingAsGrant(applicationId, userId)).toEqual({
      authorized: false,
      scopes: [],
    });
  });

  it('revokes for the caller only, leaving another user of the same app acting', async () => {
    const userId = authenticatedUser?._id ?? '';
    const { applicationId } = await client({
      type: 'first_party',
      scopes: ['user:read', 'acting-as:offline'],
    });
    const [other] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb().insert(appGrants).values([
      { userId, applicationId, scopes: ['acting-as:offline'] },
      { userId: other.id, applicationId, scopes: ['acting-as:offline'] },
    ]);

    await send('DELETE', `/auth/grants/${applicationId}`);

    expect(await resolveServiceActingAsGrant(applicationId, userId)).toMatchObject({
      authorized: false,
    });
    expect(await resolveServiceActingAsGrant(applicationId, other.id)).toMatchObject({
      authorized: true,
    });
  });

  it('is idempotent — revoking twice refreshes the marker rather than failing', async () => {
    const userId = authenticatedUser?._id ?? '';
    const { applicationId } = await client({ type: 'first_party' });

    const first = await send('DELETE', `/auth/grants/${applicationId}`);
    const second = await send('DELETE', `/auth/grants/${applicationId}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ revoked: true });
    expect(await storedRevocation(userId, applicationId)).toBeDefined();
  });

  it('still answers 200 for an applicationId that names nothing, writing no marker', async () => {
    // The marker insert carries an FK. Writing it unconditionally would fail on
    // an unknown id and surface as a 500, turning this endpoint into an
    // existence oracle it deliberately is not.
    const res = await send('DELETE', '/auth/grants/not-an-application-at-all');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true });
  });
});

/**
 * What UNDOES a revocation, and what must not.
 *
 * These drive the real `POST /auth/oauth/authorize` rather than calling
 * `clearServiceActingAsRevocation` directly, and that is the whole point of
 * them: the condition guarding the clear lives in `recordAppGrant`, so a test
 * that calls the clear itself proves the clear works and says nothing about WHEN
 * it runs. Mutation-verified — removing the `acting-as:offline` condition and
 * clearing on every authorize survived the suite until these existed.
 */
describe('POST /auth/oauth/authorize — undoing a revocation', () => {
  it('does NOT clear a revocation on an authorize that records a grant for OTHER scopes', async () => {
    // The scope here has to be consent-required but NOT `acting-as:offline`,
    // and that is the whole subtlety of this test.
    //
    // `recordAppGrant` — where the clear lives — is only called when the app is
    // untrusted OR the request names a consent-required scope. So an ORDINARY
    // first-party authorize (`user:read`) never reaches the clear at all, and a
    // test using one passes whether the condition exists or not. Measured: with
    // `user:read` this test survived the mutation that removes the condition.
    //
    // `follows:write` is consent-required, so the grant IS recorded, the clear
    // IS reached, and the condition is the only thing stopping it running.
    const userId = authenticatedUser?._id ?? '';
    const { clientId, applicationId } = await client({
      type: 'first_party',
      scopes: ['user:read', 'follows:write'],
    });
    await send('DELETE', `/auth/grants/${applicationId}`);
    expect(await storedRevocation(userId, applicationId)).toBeDefined();

    const res = await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read follows:write',
    });

    expect(res.status).toBe(200);
    // The grant WAS recorded — proving the clear was reached and declined,
    // rather than the whole branch having been skipped.
    expect((await storedGrant(userId, applicationId)).scopes).toEqual([
      'user:read',
      'follows:write',
    ]);
    expect(await storedRevocation(userId, applicationId)).toBeDefined();
    expect(await resolveServiceActingAsGrant(applicationId, userId)).toEqual({
      authorized: false,
      scopes: [],
    });
  });

  it('does NOT clear a revocation on an ordinary auto-approved first-party authorize', async () => {
    // The other half: an ordinary first-party sign-in records no grant at all,
    // so nothing runs that could clear the marker. Weaker than the test above —
    // it cannot detect the condition being removed — and kept because it pins
    // the behaviour a user actually experiences: revoke Alia, sign in again,
    // still revoked.
    const userId = authenticatedUser?._id ?? '';
    const { clientId, applicationId } = await client({ type: 'first_party' });
    await send('DELETE', `/auth/grants/${applicationId}`);

    const res = await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read files:read',
    });

    expect(res.status).toBe(200);
    expect(await storedRevocation(userId, applicationId)).toBeDefined();
    expect(await resolveServiceActingAsGrant(applicationId, userId)).toEqual({
      authorized: false,
      scopes: [],
    });
  });

  it('clears it when the authorize names acting-as:offline', async () => {
    // That scope is consent-required, so reaching here with it means the user
    // saw a consent screen and approved — the explicit decision the clear needs.
    const userId = authenticatedUser?._id ?? '';
    const { clientId, applicationId } = await client({
      type: 'first_party',
      scopes: ['user:read', 'acting-as:offline'],
    });
    await send('DELETE', `/auth/grants/${applicationId}`);
    expect(await storedRevocation(userId, applicationId)).toBeDefined();

    const res = await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read acting-as:offline',
    });

    expect(res.status).toBe(200);
    expect(await storedRevocation(userId, applicationId)).toBeUndefined();
    expect(await resolveServiceActingAsGrant(applicationId, userId)).toMatchObject({
      authorized: true,
    });
  });

  it('does not clear ANOTHER user revocation of the same application', async () => {
    const { clientId, applicationId } = await client({
      type: 'first_party',
      scopes: ['user:read', 'acting-as:offline'],
    });
    const [other] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb()
      .insert(serviceActingAsRevocations)
      .values({ userId: other.id, applicationId });

    await send('POST', '/auth/oauth/authorize', {
      clientId,
      redirectUri: REDIRECT,
      scope: 'user:read acting-as:offline',
    });

    expect(await storedRevocation(other.id, applicationId)).toBeDefined();
  });
});
