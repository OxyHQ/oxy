/**
 * GitHub trusted publishing (ADR 0057), end to end against a REAL Postgres:
 * `POST /auth/service-token/github-actions` exchanges a GitHub Actions OIDC
 * token for a service token, and that token publishes through the shipped
 * `/updates/v1` router behind the shipped `serviceAuthMiddleware`.
 *
 * GitHub is replaced by a local RSA key whose JWKS is served at GitHub's exact
 * JWKS URL through `fetch`; every other part of the path is the production one.
 * Each refusal is paired with the valid request it differs from by one claim,
 * so a 4xx that came from a broken fixture cannot pass as a security property.
 */

import express from 'express';
import request from 'supertest';
import { generateKeyPairSync, randomBytes, randomInt, sign, type KeyObject } from 'node:crypto';

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
const mockCreateUpdate = jest.fn();
jest.mock('../../services/updates/publish.service', () => ({
  __esModule: true,
  initAssets: jest.fn(),
  completeAssets: jest.fn(),
  createUpdate: (...a: unknown[]) => mockCreateUpdate(...a),
  setRollout: jest.fn(),
  rollback: jest.fn(),
  rollbackToEmbedded: jest.fn(),
  promote: jest.fn(),
  listChannels: jest.fn(),
  listUpdates: jest.fn(),
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applicationCredentials,
  applications,
  githubTrustedPublishers,
  users,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../../middleware/auth';
import { verifyServiceToken } from '../../middleware/serviceToken';
import {
  GITHUB_ACTIONS_ISSUER,
  GITHUB_ACTIONS_JWKS_URL,
} from '../../services/githubActionsOidc.service';
import { githubActionsAudience } from '../../services/githubTrustedPublishing.service';
import { hasServiceAuthority } from '../../utils/serviceAuthority';
import authRouter from '../auth';
import updatesAdminRouter from '../updatesAdmin';

// ---------------------------------------------------------------------------
// GitHub, played by a local key
// ---------------------------------------------------------------------------

const KID = 'test-github-key';
const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });
const githubJwk = {
  ...github.publicKey.export({ format: 'jwk' }),
  kid: KID,
  alg: 'RS256',
  use: 'sig',
};

const realFetch = globalThis.fetch;
let jwksFetches = 0;
beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GITHUB_ACTIONS_JWKS_URL) {
      jwksFetches += 1;
      return new Response(JSON.stringify({ keys: [githubJwk] }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(
  payload: Record<string, unknown>,
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = b64url({ alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? KID });
  const body = b64url(payload);
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${body}`),
    options.key ?? github.privateKey,
  );
  return `${header}.${body}.${signature.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  applicationId: string;
  ownerAccountId: string;
  clientId: string;
  repository: string;
  repositoryId: string;
  publisherId: string;
}

async function fixture(
  options: { workflow?: string; type?: 'first_party' | 'third_party' } = {},
): Promise<Fixture> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const type = options.type ?? 'first_party';
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `Trusted publishing ${randomBytes(4).toString('hex')}`,
      ownerAccountId: owner.id,
      status: 'active',
      type,
      isOfficial: type === 'first_party',
      // Whatever else the application holds, the minted token carries only
      // `updates:publish` — asserted below.
      scopes: ['files:read', 'files:write'],
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomBytes(12).toString('base64url')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'public client',
    type: 'public',
    environment: 'development',
    publicKey: clientId,
  });
  const repository = `OxyHQ/ota-${randomBytes(6).toString('hex')}`;
  const repositoryId = String(randomInt(1, 2 ** 40));
  const [publisher] = await getDb()
    .insert(githubTrustedPublishers)
    .values({
      applicationId: app.id,
      repository,
      repositoryId,
      workflow: options.workflow ?? null,
      createdByUserId: owner.id,
    })
    .returning({ id: githubTrustedPublishers.id });
  return {
    applicationId: app.id,
    ownerAccountId: owner.id,
    clientId,
    repository,
    repositoryId,
    publisherId: publisher.id,
  };
}

/** The claims a `push` to `main` of the fixture's repository carries. */
function claims(f: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const repository = (overrides.repository as string | undefined) ?? f.repository;
  const ref = (overrides.ref as string | undefined) ?? 'refs/heads/main';
  return {
    iss: GITHUB_ACTIONS_ISSUER,
    aud: githubActionsAudience(),
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    sub: `repo:${repository}:ref:${ref}`,
    repository,
    repository_id: f.repositoryId,
    repository_owner: repository.split('/')[0],
    repository_owner_id: '123',
    ref,
    ref_type: 'branch',
    event_name: 'push',
    workflow_ref: `${repository}/.github/workflows/publish-update.yml@${ref}`,
    job_workflow_ref: `${repository}/.github/workflows/publish-update.yml@${ref}`,
    sha: 'a'.repeat(40),
    run_id: '4242',
    run_attempt: '1',
    actor: 'octocat',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = express();
server.use(express.json());
server.use('/auth', authRouter);
server.use('/updates/v1', updatesAdminRouter);
// A route that needs a scope the publisher never grants.
server.get('/files-probe', serviceAuthMiddleware, (req: ServiceAuthRequest, res) => {
  if (!hasServiceAuthority(req.serviceApp, 'files:read'))
    return res.status(403).json({ error: 'scope_required' });
  return res.json({ ok: true });
});
server.use(errorHandler);

function exchange(clientId: string, token: string) {
  return request(server).post('/auth/service-token/github-actions').send({ clientId, token });
}

function publishBody(applicationId: string): Record<string, unknown> {
  return {
    applicationId,
    channel: 'production',
    runtimeVersion: '1.0.0',
    platform: 'ios',
    launchAsset: { sha256: 'a'.repeat(64), key: 'bundle', contentType: 'application/javascript' },
    assets: [],
    extra: { expoClient: { name: 'demo' } },
  };
}

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => {
  mockCreateUpdate.mockReset();
  mockCreateUpdate.mockResolvedValue({ id: 'new-update' });
});

function reasonOf(body: Record<string, unknown>): unknown {
  const details = (body.details ?? (body.error as Record<string, unknown> | undefined)?.details) as
    | Record<string, unknown>
    | undefined;
  return details?.reason ?? body.reason;
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

describe('POST /auth/service-token/github-actions', () => {
  it('mints a five-minute updates:publish token for exactly that application', async () => {
    const f = await fixture();
    const response = await exchange(f.clientId, signJwt(claims(f)));
    expect(response.status).toBe(200);
    const data = response.body.data as { token: string; expiresIn: number; appName: string };
    expect(data.expiresIn).toBeLessThanOrEqual(900);
    const verified = verifyServiceToken(data.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload).toMatchObject({
      appId: f.applicationId,
      ownerAccountId: f.ownerAccountId,
      credentialId: `tp_${f.publisherId}`,
      authority: 'external',
      tier: 'external',
      scopes: ['updates:publish'],
    });
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBeLessThanOrEqual(900);
    const [row] = await getDb()
      .select({ lastUsedAt: githubTrustedPublishers.lastUsedAt })
      .from(githubTrustedPublishers)
      .where(eq(githubTrustedPublishers.id, f.publisherId));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('matches the repository name case-insensitively, as GitHub resolves it', async () => {
    const f = await fixture();
    const shouted = f.repository.toUpperCase();
    const response = await exchange(f.clientId, signJwt(claims(f, { repository: shouted })));
    expect(response.status).toBe(200);
  });

  it.each([
    ['another repository', (f: Fixture) => ({ repository: `${f.repository}-fork` })],
    ['a recreated repository (same name, new id)', () => ({ repository_id: '999999999999' })],
    [
      'another owner',
      (f: Fixture) => ({
        repository: `Evil/${f.repository.split('/')[1]}`,
        repository_owner: 'Evil',
      }),
    ],
    ['an owner claim that disagrees with the repository', () => ({ repository_owner: 'Evil' })],
    ['another branch', () => ({ ref: 'refs/heads/feature' })],
    ['a tag', () => ({ ref: 'refs/tags/v1.0.0' })],
  ])('refuses %s', async (_label, override) => {
    const f = await fixture();
    expect((await exchange(f.clientId, signJwt(claims(f)))).status).toBe(200);
    const response = await exchange(f.clientId, signJwt(claims(f, override(f))));
    expect(response.status).toBe(403);
    expect(reasonOf(response.body)).toBe('no_trusted_publisher');
  });

  it.each(['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment'])(
    'refuses a %s event even on main',
    async (eventName) => {
      const f = await fixture();
      const response = await exchange(f.clientId, signJwt(claims(f, { event_name: eventName })));
      expect(response.status).toBe(403);
      expect(reasonOf(response.body)).toBe('event_not_allowed');
    },
  );

  it('admits a manual workflow_dispatch run on main', async () => {
    const f = await fixture();
    const response = await exchange(
      f.clientId,
      signJwt(claims(f, { event_name: 'workflow_dispatch' })),
    );
    expect(response.status).toBe(200);
  });

  it('pins the workflow file when the publisher names one', async () => {
    const f = await fixture({ workflow: '.github/workflows/publish-update.yml' });
    expect((await exchange(f.clientId, signJwt(claims(f)))).status).toBe(200);
    const other = await exchange(
      f.clientId,
      signJwt(
        claims(f, { workflow_ref: `${f.repository}/.github/workflows/other.yml@refs/heads/main` }),
      ),
    );
    expect(other.status).toBe(403);
    expect(reasonOf(other.body)).toBe('no_trusted_publisher');
  });

  it.each([
    ['the wrong audience', { aud: 'https://evil.example' }, 'wrong_audience'],
    ['an audience array', { aud: [githubActionsAudience()] }, 'wrong_audience'],
    [
      'the wrong issuer',
      { iss: 'https://token.actions.githubusercontent.com.evil' },
      'wrong_issuer',
    ],
    [
      'an expired token',
      {
        iat: Math.floor(Date.now() / 1000) - 900,
        nbf: Math.floor(Date.now() / 1000) - 900,
        exp: Math.floor(Date.now() / 1000) - 600,
      },
      'expired',
    ],
    ['a token from the future', { iat: Math.floor(Date.now() / 1000) + 600 }, 'not_yet_valid'],
    ['a token with no repository_id', { repository_id: undefined }, 'missing_claims'],
  ])('refuses %s', async (_label, override, reason) => {
    const f = await fixture();
    const response = await exchange(f.clientId, signJwt(claims(f, override)));
    expect(response.status).toBe(401);
    expect(reasonOf(response.body)).toBe(reason);
  });

  it('refuses a token signed by any key but GitHub’s', async () => {
    const f = await fixture();
    const forged = await exchange(f.clientId, signJwt(claims(f), { key: impostor.privateKey }));
    expect(forged.status).toBe(401);
    expect(reasonOf(forged.body)).toBe('bad_signature');

    // A genuine token whose claims were edited after GitHub signed them.
    const [header, , signature] = signJwt(claims(f)).split('.');
    const tampered = `${header}.${b64url(claims(f, { ref: 'refs/heads/main', repository_id: '1' }))}.${signature}`;
    const edited = await exchange(f.clientId, tampered);
    expect(edited.status).toBe(401);
    expect(reasonOf(edited.body)).toBe('bad_signature');
  });

  it('refuses an unknown key id, and refetches the JWKS at most once a minute for it', async () => {
    const f = await fixture();
    const before = jwksFetches;
    for (let i = 0; i < 3; i += 1) {
      const response = await exchange(
        f.clientId,
        signJwt(claims(f), { key: impostor.privateKey, kid: `forged-${i}` }),
      );
      expect(response.status).toBe(401);
      expect(reasonOf(response.body)).toBe('unknown_key');
    }
    expect(jwksFetches - before).toBeLessThanOrEqual(1);
  });

  it.each(['none', 'HS256', 'RS512'])('refuses alg %s', async (alg) => {
    const f = await fixture();
    const response = await exchange(f.clientId, signJwt(claims(f), { alg }));
    expect(response.status).toBe(401);
    expect(reasonOf(response.body)).toBe('malformed');
  });

  it('refuses an unknown client id', async () => {
    const f = await fixture();
    const response = await exchange('oxy_dk_unknown', signJwt(claims(f)));
    expect(response.status).toBe(401);
    expect(reasonOf(response.body)).toBe('unknown_client');
  });

  it('never applies one application’s publisher to another application', async () => {
    const a = await fixture();
    const b = await fixture();
    // b's repository presenting a's client id.
    const response = await exchange(a.clientId, signJwt(claims(b)));
    expect(response.status).toBe(403);
    expect(reasonOf(response.body)).toBe('no_trusted_publisher');
  });

  it('serves a third-party application through the publisher it registered', async () => {
    const f = await fixture({ type: 'third_party' });
    const response = await exchange(f.clientId, signJwt(claims(f)));
    expect(response.status).toBe(200);
    const verified = verifyServiceToken((response.body.data as { token: string }).token);
    expect(verified.ok && verified.payload.scopes).toEqual(['updates:publish']);
  });

  it('refuses a body with extra fields', async () => {
    const f = await fixture();
    const response = await request(server)
      .post('/auth/service-token/github-actions')
      .send({ clientId: f.clientId, token: signJwt(claims(f)), scopes: ['files:write'] });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The minted token, downstream
// ---------------------------------------------------------------------------

describe('a trusted-publisher token', () => {
  async function mint(f: Fixture): Promise<string> {
    const response = await exchange(f.clientId, signJwt(claims(f)));
    expect(response.status).toBe(200);
    return (response.body.data as { token: string }).token;
  }

  it('publishes an update to its own application', async () => {
    const f = await fixture();
    const token = await mint(f);
    const response = await request(server)
      .post('/updates/v1/updates')
      .auth(token, { type: 'bearer' })
      .send(publishBody(f.applicationId));
    expect(response.status).toBe(200);
    expect(mockCreateUpdate).toHaveBeenCalledTimes(1);
  });

  it('cannot publish to any other application', async () => {
    const f = await fixture();
    const other = await fixture();
    const token = await mint(f);
    const response = await request(server)
      .post('/updates/v1/updates')
      .auth(token, { type: 'bearer' })
      .send(publishBody(other.applicationId));
    expect(response.status).toBe(403);
    expect(mockCreateUpdate).not.toHaveBeenCalled();
  });

  it('carries no authority but updates:publish', async () => {
    const f = await fixture();
    const token = await mint(f);
    const response = await request(server).get('/files-probe').auth(token, { type: 'bearer' });
    expect(response.status).toBe(403);
  });

  it('stops working the moment its publisher is deleted', async () => {
    const f = await fixture();
    const token = await mint(f);
    const publish = () =>
      request(server)
        .post('/updates/v1/updates')
        .auth(token, { type: 'bearer' })
        .send(publishBody(f.applicationId));
    expect((await publish()).status).toBe(200);
    await getDb()
      .delete(githubTrustedPublishers)
      .where(eq(githubTrustedPublishers.id, f.publisherId));
    expect((await publish()).status).toBe(401);
  });

  it('stops working when the application is suspended', async () => {
    const f = await fixture();
    const token = await mint(f);
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, f.applicationId));
    const response = await request(server)
      .post('/updates/v1/updates')
      .auth(token, { type: 'bearer' })
      .send(publishBody(f.applicationId));
    expect(response.status).toBe(401);
  });
});
