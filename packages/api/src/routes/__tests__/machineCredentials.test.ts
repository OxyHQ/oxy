/**
 * `oxy_sk_…` machine credentials end to end (issue #972 §2.3).
 *
 * Runs against the REAL Postgres the harness migrated, through the application's
 * own pool and the shipped routers: the credential lifecycle routes on
 * `/applications`, and the machine bearer lane on the `/v1/chat/completions`
 * mount an OpenAI SDK actually points at. What passes is what the shipped DDL,
 * the shipped middleware and the shipped queries do together.
 *
 * Three seams are mocked, and each for a reason that is NOT the subject here:
 *
 *   - `account.service`, which grants the caller an effective account role;
 *   - `middleware/auth`, whose `authMiddleware` supplies the Console caller's
 *     identity AND is the lane `machineOrUserAuth` falls through to. The stub
 *     accepts exactly one session bearer and 401s everything else, so the
 *     fall-through is observable rather than assumed;
 *   - `axios`, so a successful proxy is a deterministic 200 rather than a
 *     network call. That 200 is the positive marker for "the request got past
 *     authentication and reached the handler" — asserting a 401 did not happen
 *     is not the same claim, and a config error would produce the same 500 for
 *     an authenticated and an unauthenticated caller alike.
 *
 * Every row is minted per test with a database-generated id, so no assertion
 * depends on a table being empty and this file may run beside the others.
 *
 * ## The deployment environment these tests run in
 *
 * `deploymentCredentialEnvironment()` reads `NODE_ENV`, which jest sets to
 * `test`, so this process accepts `development` credentials. That is why every
 * fixture is `development` and why a `production` one is the wrong-environment
 * case — not an arbitrary choice of fixture value.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

// --- account.service mock ---------------------------------------------------

const accessGrants = new Map<string, AccountRole>();

const accountServiceMock = {
  resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) => {
    const role = userId === accountId ? 'owner' : accessGrants.get(`${userId}:${accountId}`);
    if (!role) return null;
    return {
      role,
      permissions: permissionsForAccountRole(role),
      source: userId === accountId ? 'self' : 'direct',
      membership: null,
    };
  }),
  listAccessibleAccounts: jest.fn(async (userId: string) => [
    { accountId: userId, relationship: 'self', callerMembership: null },
  ]),
};

jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: accountServiceMock,
}));

/** The one bearer the stubbed session lane accepts. */
const SESSION_BEARER = 'session-bearer';

const mockAuthMiddleware = jest.fn();
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

const mockAxiosPost = jest.fn(async () => ({ data: { id: 'chatcmpl-test' } }));
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockAxiosPost(...args) },
}));

const mockRefreshOriginRegistry = jest.fn(async () => {});
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: () => mockRefreshOriginRegistry(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Set BEFORE the router is required, because `alia.ts` reads it once at module
// load. With `axios` stubbed nothing leaves the process; this only decides which
// branch of the handler runs, and it has to be the one that proxies.
process.env.ALIA_API_KEY = 'test-upstream-key';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentialAuditEvents } from '../../db/schema/applicationCredentialAuditEvents';
import { applicationCredentials, applications, users } from '../../db/schema';
import applicationsRouter from '../applications';
import aliaRouter from '../alia';
import { errorHandler } from '../../middleware/errorHandler';
import {
  MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE,
  resolveMachineCredential,
} from '../../middleware/machineCredential';
import { resetFailureAuditCooldown } from '../../services/applicationCredentialAudit.service';
import { CREDENTIAL_ENVIRONMENT_VAR } from '../../utils/credentialEnvironment';

interface JsonResponse {
  status: number;
  /** The raw response text, so a "the secret never appears" search is total. */
  raw: string;
  body: Record<string, unknown> & {
    credential?: Record<string, unknown>;
    credentials?: Array<Record<string, unknown>>;
    secret?: string | null;
    token?: string;
    rotatedFrom?: string;
    graceExpiresAt?: string | null;
    error?: string;
    message?: string;
  };
}

async function request(
  method: string,
  path: string,
  options: { payload?: unknown; bearer?: string } = {}
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(options.payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          Authorization: `Bearer ${options.bearer ?? SESSION_BEARER}`,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          // `express-rate-limit` sends its `message` as text/plain, so a 429 is
          // the one response on these routes that is not JSON. `raw` is always
          // populated, and the assertions that care read it.
          let body: Record<string, unknown> = {};
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              body = {};
            }
          }
          resolve({ status: res.statusCode ?? 0, raw, body });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;
let OWNER_ID = '';

/** A real `users` row, standing in for an account in the account graph. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A real application owned by `OWNER_ID`, granted `scopes`. */
async function seedApp(scopes: string[] = ['inference:invoke']): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `Machine App ${crypto.randomBytes(4).toString('hex')}`,
      ownerAccountId: OWNER_ID,
      createdByUserId: OWNER_ID,
      scopes,
    })
    .returning({ id: applications.id });
  return row.id;
}

interface CreatedMachineCredential {
  applicationId: string;
  credentialId: string;
  token: string;
  tokenPrefix: string;
  response: JsonResponse;
}

/** Create a machine credential through the real route. */
async function createMachineCredential(
  options: {
    applicationId?: string;
    appScopes?: string[];
    scopes?: string[];
    environment?: 'development' | 'staging' | 'production';
    expiresInSeconds?: number;
  } = {}
): Promise<CreatedMachineCredential> {
  const applicationId = options.applicationId ?? (await seedApp(options.appScopes));
  const response = await request('POST', `/applications/${applicationId}/credentials`, {
    payload: {
      name: 'Server key',
      type: 'machine',
      environment: options.environment ?? 'development',
      scopes: options.scopes ?? ['inference:invoke'],
      ...(options.expiresInSeconds !== undefined
        ? { expiresInSeconds: options.expiresInSeconds }
        : {}),
    },
  });
  if (response.status !== 201) {
    throw new Error(`credential create failed: ${response.status} ${response.raw}`);
  }
  return {
    applicationId,
    credentialId: response.body.credential?._id as string,
    token: response.body.token as string,
    tokenPrefix: response.body.credential?.tokenPrefix as string,
    response,
  };
}

/** Re-read a credential row WITH its hash columns — the tests' own read. */
async function readCredentialRow(
  id: string
): Promise<typeof applicationCredentials.$inferSelect | undefined> {
  const [row] = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, id))
    .limit(1);
  return row;
}

/** Every audit row for one credential, oldest first. */
async function auditEventsFor(
  credentialId: string
): Promise<(typeof applicationCredentialAuditEvents.$inferSelect)[]> {
  return getDb()
    .select()
    .from(applicationCredentialAuditEvents)
    .where(eq(applicationCredentialAuditEvents.credentialId, credentialId))
    .orderBy(applicationCredentialAuditEvents.createdAt);
}

/** Ask a chat completion with `token` as the bearer. */
async function chat(token: string): Promise<JsonResponse> {
  return request('POST', '/v1/chat/completions', {
    bearer: token,
    payload: { model: 'gpt-test', messages: [] },
  });
}

/**
 * The predicate the "never stores the plaintext" assertion is made of, named so
 * the positive control can exercise the SAME code rather than a paraphrase of
 * it.
 */
function hashColumnHoldsPlaintext(
  row: typeof applicationCredentials.$inferSelect | undefined,
  token: string
): boolean {
  if (!row?.tokenHash) return false;
  const secretHalf = token.slice(token.lastIndexOf('_') + 1);
  return row.tokenHash === token || row.tokenHash.includes(secretHalf);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/applications', applicationsRouter);
  app.use('/v1', aliaRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  accessGrants.clear();
  resetFailureAuditCooldown();
  delete process.env[CREDENTIAL_ENVIRONMENT_VAR];
  OWNER_ID = await account();
  mockAxiosPost.mockImplementation(async () => ({ data: { id: 'chatcmpl-test' } }));
  mockAuthMiddleware.mockImplementation(
    (
      req: { headers: Record<string, string | undefined>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      const bearer = req.headers.authorization?.slice('Bearer '.length);
      if (bearer !== SESSION_BEARER) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      req.user = { _id: { toString: () => OWNER_ID }, isStaff: false };
      next();
    }
  );
});

// ---------------------------------------------------------------------------
// Creation — one-time display
// ---------------------------------------------------------------------------

describe('POST /applications/:appId/credentials — machine', () => {
  it('returns the full bearer token EXACTLY once, and no read ever returns it again', async () => {
    const { applicationId, credentialId, token, response } = await createMachineCredential();

    expect(token).toMatch(/^oxy_sk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    // `secret` stays null on a machine credential: the wire shape every existing
    // client reads is unchanged, and the two lanes are distinct in the response
    // as well as in the table.
    expect(response.body.secret).toBeNull();

    const list = await request('GET', `/applications/${applicationId}/credentials`);
    expect(list.status).toBe(200);
    expect(list.raw).not.toContain(token);
    const listed = list.body.credentials?.find((row) => row._id === credentialId);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('token');
    expect(listed).not.toHaveProperty('tokenHash');
    expect(listed).not.toHaveProperty('secretHash');

    // …and the whole application detail read, in case a second serializer ever
    // grows a credentials projection.
    const detail = await request('GET', `/applications/${applicationId}`);
    expect(detail.raw).not.toContain(token);
  });

  it('publishes the lookup prefix, which is the token minus its 256 secret bits', async () => {
    const { token, tokenPrefix } = await createMachineCredential();
    expect(tokenPrefix).toMatch(/^oxy_sk_[0-9a-f]{16}$/);
    expect(token.startsWith(`${tokenPrefix}_`)).toBe(true);
    expect(tokenPrefix.length).toBeLessThan(token.length);
  });

  it('stores a hash and NEVER the plaintext — with a control proving the check can fail', async () => {
    const { credentialId, token } = await createMachineCredential();
    const row = await readCredentialRow(credentialId);

    expect(row?.tokenHash).toBeTruthy();
    expect(hashColumnHoldsPlaintext(row, token)).toBe(false);
    expect(row?.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));

    // POSITIVE CONTROL, in the same currency as the measurement: plant the
    // plaintext into the same column on a second row and confirm the SAME
    // predicate fires. Without this, `false` above is what a predicate that
    // examines nothing also returns.
    const applicationId = await seedApp();
    const [planted] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId,
        name: 'planted',
        publicKey: `oxy_dk_${crypto.randomBytes(12).toString('hex')}`,
        tokenPrefix: `oxy_sk_${crypto.randomBytes(8).toString('hex')}`,
        tokenHash: token,
        type: 'machine',
        environment: 'development',
        scopes: ['inference:invoke'],
        createdByUserId: OWNER_ID,
      })
      .returning({ id: applicationCredentials.id });
    expect(hashColumnHoldsPlaintext(await readCredentialRow(planted.id), token)).toBe(true);
  });

  it('holds NO secret_hash, so it cannot cross into the OAuth/service lane', async () => {
    const { credentialId } = await createMachineCredential();
    const row = await readCredentialRow(credentialId);
    expect(row?.secretHash).toBeNull();
    expect(row?.type).toBe('machine');
  });

  it('refuses a machine credential that names no scope', async () => {
    const applicationId = await seedApp();
    const res = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: { name: 'Scopeless', type: 'machine', environment: 'development' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one scope/i);
  });

  it('refuses a scope the owning application was never granted', async () => {
    const applicationId = await seedApp(['inference:invoke']);
    const res = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: {
        name: 'Over-reach',
        type: 'machine',
        environment: 'development',
        scopes: ['inference:invoke', 'files:write'],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('files:write');
  });

  it('accepts expiresInSeconds on a machine credential and refuses it on the others', async () => {
    const applicationId = await seedApp();
    const machine = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: {
        name: 'Short-lived',
        type: 'machine',
        environment: 'development',
        scopes: ['inference:invoke'],
        expiresInSeconds: 3600,
      },
    });
    expect(machine.status).toBe(201);
    const row = await readCredentialRow(machine.body.credential?._id as string);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row?.status).toBe('active');

    const confidential = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: {
        name: 'Not allowed',
        type: 'confidential',
        environment: 'development',
        expiresInSeconds: 3600,
      },
    });
    expect(confidential.status).toBe(400);
    expect(confidential.body.message).toMatch(/machine credentials/i);
  });

  it('leaves the confidential lane byte-identical: a secret, no token', async () => {
    const applicationId = await seedApp();
    const res = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: { name: 'OAuth client', type: 'confidential', environment: 'development' },
    });
    expect(res.status).toBe(201);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body).not.toHaveProperty('token');
    expect(res.body.credential?.publicKey).toMatch(/^oxy_dk_/);
    expect(res.body.credential?.tokenPrefix).toBeUndefined();

    const row = await readCredentialRow(res.body.credential?._id as string);
    expect(row?.secretHash).toBeTruthy();
    expect(row?.tokenPrefix).toBeNull();
    expect(row?.tokenHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('the machine bearer lane', () => {
  it('authenticates a valid token on POST /v1/chat/completions', async () => {
    const { token } = await createMachineCredential();
    const res = await chat(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'chatcmpl-test' });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('refuses a tampered token, and never reaches the upstream', async () => {
    const { token } = await createMachineCredential();
    // Flip one character of the SECRET half — the prefix still resolves a real
    // credential, so this is the case the constant-time comparison decides.
    const secretStart = token.lastIndexOf('_') + 1;
    const flipped = token[secretStart] === 'a' ? 'b' : 'a';
    const tampered = `${token.slice(0, secretStart)}${flipped}${token.slice(secretStart + 1)}`;

    const res = await chat(tampered);
    expect(res.status).toBe(401);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('refuses a token whose credential has expired', async () => {
    const { credentialId, token } = await createMachineCredential();
    await getDb()
      .update(applicationCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(applicationCredentials.id, credentialId));

    expect(await chat(token)).toMatchObject({ status: 401 });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('refuses a token whose credential has been revoked', async () => {
    const { applicationId, credentialId, token } = await createMachineCredential();
    expect(await chat(token)).toMatchObject({ status: 200 });

    const revoke = await request('DELETE', `/applications/${applicationId}/credentials/${credentialId}`);
    expect(revoke.status).toBe(200);

    mockAxiosPost.mockClear();
    expect(await chat(token)).toMatchObject({ status: 401 });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('refuses a credential minted for another environment', async () => {
    const { token } = await createMachineCredential({ environment: 'production' });
    expect(await chat(token)).toMatchObject({ status: 401 });

    // …and the override is what makes `staging` reachable at all: the SAME token
    // is accepted once the deployment declares the environment it was minted
    // for. Without this the check would be indistinguishable from "production
    // credentials never work".
    process.env[CREDENTIAL_ENVIRONMENT_VAR] = 'production';
    expect(await chat(token)).toMatchObject({ status: 200 });
  });

  it('refuses a credential whose application is no longer active', async () => {
    const { applicationId, token } = await createMachineCredential();
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, applicationId));

    expect(await chat(token)).toMatchObject({ status: 401 });
  });

  it('refuses a bare oxy_dk_ public identifier — it resolves nothing, and falls through', async () => {
    const { applicationId } = await createMachineCredential();
    const [credential] = await getDb()
      .select({ publicKey: applicationCredentials.publicKey })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, applicationId))
      .limit(1);

    // Structural: the public identifier is not a machine token shape at all, so
    // the lane never issues a query for it.
    expect(await resolveMachineCredential(credential.publicKey)).toEqual({
      ok: false,
      reason: 'not_machine_token',
    });

    // …and over HTTP it reaches the session lane, which refuses it. Asserting
    // the stub was CALLED is what separates "fell through and was refused" from
    // "the machine lane silently accepted it".
    const res = await chat(credential.publicKey);
    expect(res.status).toBe(401);
    expect(mockAuthMiddleware).toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('answers a malformed oxy_sk_ in the machine lane rather than the session lane', async () => {
    const res = await chat('oxy_sk_not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/API key/i);
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
  });

  it('still serves an ordinary session bearer on the same route', async () => {
    const res = await chat(SESSION_BEARER);
    expect(res.status).toBe(200);
    expect(mockAuthMiddleware).toHaveBeenCalled();
  });

  it('resolves the attribution every inference request must carry', async () => {
    const { applicationId, credentialId, token } = await createMachineCredential();
    const resolution = await resolveMachineCredential(token);
    expect(resolution).toEqual({
      ok: true,
      principal: {
        credentialId,
        applicationId,
        applicationName: expect.any(String),
        ownerAccountId: OWNER_ID,
        environment: 'development',
        scopes: ['inference:invoke'],
      },
    });
  });

  it('records last_used_at on first use', async () => {
    const { credentialId, token } = await createMachineCredential();
    expect((await readCredentialRow(credentialId))?.lastUsedAt).toBeNull();

    expect(await chat(token)).toMatchObject({ status: 200 });
    // The refresh is detached from the response, so poll rather than assume the
    // write has landed by the time the body arrives.
    let lastUsedAt: Date | null = null;
    for (let attempt = 0; attempt < 40 && !lastUsedAt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      lastUsedAt = (await readCredentialRow(credentialId))?.lastUsedAt ?? null;
    }
    expect(lastUsedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Scope intersection
// ---------------------------------------------------------------------------

describe('scope intersection', () => {
  it('drops a credential scope its application has since lost', async () => {
    const applicationId = await seedApp(['inference:invoke', 'files:read']);
    const { token } = await createMachineCredential({
      applicationId,
      scopes: ['inference:invoke', 'files:read'],
    });

    await getDb()
      .update(applications)
      .set({ scopes: ['files:read'] })
      .where(eq(applications.id, applicationId));

    const resolution = await resolveMachineCredential(token);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      // The credential still NAMES `inference:invoke`; the application no longer
      // grants it, so the principal does not get it.
      expect(resolution.principal.scopes).toEqual(['files:read']);
    }
  });

  it('403s — not 401s — a credential that authenticates without the required scope', async () => {
    const applicationId = await seedApp(['inference:invoke', 'files:read']);
    const { credentialId, token } = await createMachineCredential({
      applicationId,
      scopes: ['files:read'],
    });

    const res = await chat(token);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('inference:invoke');
    expect(mockAxiosPost).not.toHaveBeenCalled();

    const failures = (await auditEventsFor(credentialId)).filter(
      (event) => event.eventType === 'validation_failed'
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('scope_missing');
    expect(failures[0].metadata).toEqual({ requiredScope: 'inference:invoke' });
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('POST /applications/:appId/credentials/:credId/rotate — machine', () => {
  it('with NO grace configured, the previous token stops working immediately', async () => {
    const { applicationId, credentialId, token } = await createMachineCredential();
    expect(await chat(token)).toMatchObject({ status: 200 });

    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`
    );
    expect(rotate.status).toBe(200);
    expect(rotate.body.graceExpiresAt).toBeNull();
    expect(rotate.body.secret).toBeNull();

    const rotatedToken = rotate.body.token as string;
    expect(rotatedToken).toMatch(/^oxy_sk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(rotatedToken).not.toBe(token);

    // Immediately, with no waiting: the previous credential is `revoked`, not
    // `deprecated` with a deadline.
    expect((await readCredentialRow(credentialId))?.status).toBe('revoked');
    mockAxiosPost.mockClear();
    expect(await chat(token)).toMatchObject({ status: 401 });
    expect(mockAxiosPost).not.toHaveBeenCalled();

    expect(await chat(rotatedToken)).toMatchObject({ status: 200 });
  });

  it('with a grace configured, the previous token keeps working until the window ends', async () => {
    const { applicationId, credentialId, token } = await createMachineCredential();

    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`,
      { payload: { graceSeconds: 1 } }
    );
    expect(rotate.status).toBe(200);
    expect(typeof rotate.body.graceExpiresAt).toBe('string');
    expect((await readCredentialRow(credentialId))?.status).toBe('deprecated');

    // Inside the window: both tokens serve.
    expect(await chat(token)).toMatchObject({ status: 200 });
    expect(await chat(rotate.body.token as string)).toMatchObject({ status: 200 });

    // Past it: only the replacement does. This waits on the real clock rather
    // than moving the row underneath the code, so what is measured is
    // `isCredentialUsable` reading the deadline the route wrote.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    resetFailureAuditCooldown();
    mockAxiosPost.mockClear();
    expect(await chat(token)).toMatchObject({ status: 401 });
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(await chat(rotate.body.token as string)).toMatchObject({ status: 200 });
  }, 20000);

  it('refuses graceSeconds when rotating a credential that is not a machine one', async () => {
    const applicationId = await seedApp();
    const created = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: { name: 'OAuth client', type: 'confidential', environment: 'development' },
    });
    const credentialId = created.body.credential?._id as string;

    const res = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`,
      { payload: { graceSeconds: 60 } }
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/machine credential/i);
    // Nothing was minted: the refusal happens inside the transaction.
    expect((await readCredentialRow(credentialId))?.status).toBe('active');
  });

  it('leaves the confidential rotation contract unchanged — a fixed seven-day grace', async () => {
    const applicationId = await seedApp();
    const created = await request('POST', `/applications/${applicationId}/credentials`, {
      payload: { name: 'OAuth client', type: 'confidential', environment: 'development' },
    });
    const credentialId = created.body.credential?._id as string;

    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`
    );
    expect(rotate.status).toBe(200);
    expect(typeof rotate.body.secret).toBe('string');
    expect(rotate.body).not.toHaveProperty('token');

    const previous = await readCredentialRow(credentialId);
    expect(previous?.status).toBe('deprecated');
    const graceDays =
      ((previous?.expiresAt?.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(graceDays).toBeGreaterThan(6.9);
    expect(graceDays).toBeLessThan(7.1);
  });

  it('links the replacement back to what it replaced', async () => {
    const { applicationId, credentialId } = await createMachineCredential();
    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`
    );
    expect(rotate.body.rotatedFrom).toBe(credentialId);
    expect(rotate.body.credential?.rotatedFromCredentialId).toBe(credentialId);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('credential audit events', () => {
  it('records `created` in the same write as the credential', async () => {
    const { applicationId, credentialId } = await createMachineCredential();
    const events = await auditEventsFor(credentialId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      applicationId,
      eventType: 'created',
      actorUserId: OWNER_ID,
      environment: 'development',
      reason: null,
    });
    expect(events[0].metadata).toEqual({ type: 'machine', scopes: ['inference:invoke'] });
  });

  it('records `rotated` on the old credential and `created` on the new one', async () => {
    const { applicationId, credentialId } = await createMachineCredential();
    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`,
      { payload: { graceSeconds: 60 } }
    );
    const newCredentialId = rotate.body.credential?._id as string;

    const previousEvents = await auditEventsFor(credentialId);
    expect(previousEvents.map((event) => event.eventType)).toEqual(['created', 'rotated']);
    const rotated = previousEvents[1];
    expect(rotated.metadata).toEqual({
      rotatedToCredentialId: newCredentialId,
      graceConfigured: true,
    });
    expect(rotated.effectiveUntil).toBeInstanceOf(Date);

    const newEvents = await auditEventsFor(newCredentialId);
    expect(newEvents.map((event) => event.eventType)).toEqual(['created']);
    expect(newEvents[0].metadata).toMatchObject({ rotatedFromCredentialId: credentialId });
  });

  it('records `graceConfigured: false` when no window was asked for', async () => {
    const { applicationId, credentialId } = await createMachineCredential();
    await request('POST', `/applications/${applicationId}/credentials/${credentialId}/rotate`);
    const [, rotated] = await auditEventsFor(credentialId);
    expect(rotated.metadata).toMatchObject({ graceConfigured: false });
    expect(rotated.effectiveUntil).toBeNull();
  });

  it('records `revoked`', async () => {
    const { applicationId, credentialId } = await createMachineCredential();
    await request('DELETE', `/applications/${applicationId}/credentials/${credentialId}`);
    const events = await auditEventsFor(credentialId);
    expect(events.map((event) => event.eventType)).toEqual(['created', 'revoked']);
    expect(events[1].actorUserId).toBe(OWNER_ID);
  });

  it('records a failed validation with its reason and NO actor', async () => {
    const { credentialId, token } = await createMachineCredential();
    const secretStart = token.lastIndexOf('_') + 1;
    const flipped = token[secretStart] === 'a' ? 'b' : 'a';
    await chat(`${token.slice(0, secretStart)}${flipped}${token.slice(secretStart + 1)}`);

    const failures = (await auditEventsFor(credentialId)).filter(
      (event) => event.eventType === 'validation_failed'
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('secret_mismatch');
    // A refused bearer has nobody behind it. Recording an actor here would turn
    // "we do not know who presented this" into an accusation.
    expect(failures[0].actorUserId).toBeNull();
  });

  it('distinguishes an expired credential from a wrong secret', async () => {
    const { credentialId, token } = await createMachineCredential();
    await getDb()
      .update(applicationCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(applicationCredentials.id, credentialId));

    await chat(token);
    const failures = (await auditEventsFor(credentialId)).filter(
      (event) => event.eventType === 'validation_failed'
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('not_usable');
  });

  it('writes NOTHING for a bearer that resolves to no credential', async () => {
    const before = await getDb().select().from(applicationCredentialAuditEvents);
    await chat(`oxy_sk_${'0'.repeat(16)}_${'0'.repeat(64)}`);
    const after = await getDb().select().from(applicationCredentialAuditEvents);
    // An unresolvable prefix names no application to attribute a row to, and
    // persisting one would let an anonymous caller drive unbounded inserts.
    expect(after.length).toBe(before.length);
  });

  it('suppresses a repeat of the same failure inside the cooldown', async () => {
    const { credentialId, token } = await createMachineCredential();
    const secretStart = token.lastIndexOf('_') + 1;
    const flipped = token[secretStart] === 'a' ? 'b' : 'a';
    const tampered = `${token.slice(0, secretStart)}${flipped}${token.slice(secretStart + 1)}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await chat(tampered);
    }
    const failures = (await auditEventsFor(credentialId)).filter(
      (event) => event.eventType === 'validation_failed'
    );
    expect(failures).toHaveLength(1);

    // The cooldown SUPPRESSES; it does not stop recording. Clearing it and
    // failing again writes the next row — otherwise this test would pass just as
    // well against a writer that had given up entirely.
    resetFailureAuditCooldown();
    await chat(tampered);
    expect(
      (await auditEventsFor(credentialId)).filter(
        (event) => event.eventType === 'validation_failed'
      )
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('per-credential and per-application request limits', () => {
  it('cuts a machine credential off at its per-minute ceiling', async () => {
    const { token } = await createMachineCredential();

    for (let sent = 0; sent < MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE; sent += 1) {
      const res = await chat(token);
      expect(res.status).toBe(200);
    }
    const overflow = await chat(token);
    expect(overflow.status).toBe(429);
    // Names WHICH limiter fired. The per-application ceiling is higher, so a 429
    // here that came from the wrong bucket would be a different bug wearing the
    // same status code.
    expect(overflow.raw).toContain('API key request limit');
  }, 60000);

  it('does not consume a machine budget for a session-authenticated request', async () => {
    // The limiters `skip` when there is no principal to key on. Without that
    // they would bucket every session request under one empty key and exhaust
    // the budget for every real key at once — so the assertion is that many
    // session requests in a row all still serve.
    for (let sent = 0; sent < MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE + 5; sent += 1) {
      expect(await chat(SESSION_BEARER)).toMatchObject({ status: 200 });
    }
  }, 60000);
});
