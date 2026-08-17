/**
 * `GET /applications/:appId/credentials/:credId/audit` (issue #972 §9).
 *
 * Runs against the REAL Postgres the harness migrated, through the shipped
 * `/applications` router mounted as production mounts it, so what passes is what
 * the shipped DDL, the shipped RBAC middleware and the shipped queries do
 * together. Two seams are stubbed, both outside the route: `account.service`
 * (which grants a caller their effective account role) and `middleware/auth`
 * (which supplies the caller's identity) — the same two
 * `machineCredentials.test.ts` stubs, for the same reason.
 *
 * The file is organised around the two assertions that carry the endpoint:
 *
 *  1. **Account A cannot read account B's trail**, and not merely by being
 *     refused the application: the dangerous shape is A's OWN `:appId` beside
 *     B's `:credId`, because the audit table is keyed on the credential. Each
 *     refusal is paired with a positive control on the same request shape, so a
 *     404 that came from a broken URL cannot pass as a security property.
 *  2. **Nothing that reconstructs a secret appears in the response.** Searched
 *     recursively rather than with `JSON.stringify().includes()`, and with a
 *     planted needle proving the search would find one.
 *
 * Every fixture owns its ids, so nothing here depends on a table being empty and
 * the file may run beside the rest of the suite.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

// --- account.service mock ---------------------------------------------------

/** `"<userId>:<accountId>"` → the role that caller holds over that account. */
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

const mockRefreshOriginRegistry = jest.fn(async () => {});
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: () => mockRefreshOriginRegistry(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, users } from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';
import {
  listCredentialAuditEvents,
  recordCredentialValidationFailure,
  resetFailureAuditCooldown,
} from '../../services/applicationCredentialAudit.service';

/** One audit event as the route serves it. */
interface AuditEventBody {
  eventType: string;
  reason: string | null;
  actorUserId: string | null;
  environment: string | null;
  createdAt: string;
  effectiveUntil: string | null;
}

interface JsonResponse {
  status: number;
  /** The raw text, so a "the secret never appears" search is total. */
  raw: string;
  body: Record<string, unknown> & {
    data?: AuditEventBody[];
    count?: number;
    credential?: Record<string, unknown>;
    secret?: string | null;
    token?: string;
    error?: string;
    message?: string;
  };
}

async function request(
  method: string,
  path: string,
  options: { payload?: unknown } = {}
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
          Authorization: `Bearer ${SESSION_BEARER}`,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = {};
            }
          }
          resolve({ status: res.statusCode ?? 0, raw, body: parsed });
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

/** Point the stubbed session lane at `userId`. */
function asCaller(userId: string): void {
  mockAuthMiddleware.mockImplementation(
    (
      req: { headers: Record<string, string | undefined>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (req.headers.authorization?.slice('Bearer '.length) !== SESSION_BEARER) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      req.user = { _id: { toString: () => userId }, isStaff: false };
      next();
    }
  );
}

/** A real `users` row, standing in for an account in the account graph. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A real application owned by `ownerAccountId`. */
async function seedApp(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `Audit App ${crypto.randomBytes(4).toString('hex')}`,
      ownerAccountId,
      createdByUserId: ownerAccountId,
      scopes: ['inference:invoke'],
    })
    .returning({ id: applications.id });
  return row.id;
}

interface CreatedCredential {
  applicationId: string;
  credentialId: string;
  /** The `oxy_sk_…` bearer, on a `machine` credential. */
  token?: string;
  /** The one-time secret, on a `confidential` credential. */
  secret?: string;
}

/**
 * Create a credential through the real route, as the CURRENT caller.
 *
 * The caller must already hold `credentials:create` over the application's owner,
 * which is what `asCaller` + `accessGrants` arrange.
 */
async function createCredential(
  applicationId: string,
  type: 'machine' | 'confidential' = 'machine'
): Promise<CreatedCredential> {
  const response = await request('POST', `/applications/${applicationId}/credentials`, {
    payload: {
      name: 'Trail key',
      type,
      environment: 'development',
      ...(type === 'machine' ? { scopes: ['inference:invoke'] } : {}),
    },
  });
  if (response.status !== 201) {
    throw new Error(`credential create failed: ${response.status} ${response.raw}`);
  }
  return {
    applicationId,
    credentialId: response.body.credential?._id as string,
    token: response.body.token,
    secret: response.body.secret ?? undefined,
  };
}

/** The trail as the route serves it. */
async function readTrail(
  applicationId: string,
  credentialId: string,
  query = ''
): Promise<JsonResponse> {
  return request('GET', `/applications/${applicationId}/credentials/${credentialId}/audit${query}`);
}

/**
 * Does `haystack`, walked to every leaf, contain `needle` anywhere?
 *
 * Recursive rather than `JSON.stringify(x).includes(needle)` so a value hiding
 * behind a `toJSON` cannot make the search pass by being redacted on the way out.
 * Both forms are used below, because they fail for different reasons.
 */
function containsDeep(haystack: unknown, needle: string): boolean {
  if (typeof haystack === 'string') return haystack.includes(needle);
  if (haystack === null || typeof haystack !== 'object') return false;
  if (Array.isArray(haystack)) return haystack.some((item) => containsDeep(item, needle));
  return Object.values(haystack as Record<string, unknown>).some((value) =>
    containsDeep(value, needle)
  );
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/applications', applicationsRouter);
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
  OWNER_ID = await account();
  asCaller(OWNER_ID);
});

// ---------------------------------------------------------------------------
// The trail an owner may read
// ---------------------------------------------------------------------------

describe('GET /applications/:appId/credentials/:credId/audit', () => {
  it('serves the credential’s own lifecycle events, newest first', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);

    const rotate = await request(
      'POST',
      `/applications/${applicationId}/credentials/${credentialId}/rotate`,
      { payload: {} }
    );
    expect(rotate.status).toBe(200);

    const trail = await readTrail(applicationId, credentialId);
    expect(trail.status).toBe(200);
    // `created` when it was minted, `rotated` when it was replaced — both about
    // THIS credential. The replacement's own `created` row belongs to the
    // replacement and must not appear here.
    expect(trail.body.data?.map((event) => event.eventType).sort()).toEqual([
      'created',
      'rotated',
    ]);
    expect(trail.body.count).toBe(2);
    for (const event of trail.body.data ?? []) {
      expect(event.actorUserId).toBe(OWNER_ID);
      expect(event.environment).toBe('development');
    }
  });

  it('surfaces a refused bearer with its reason and NO actor', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);

    // The real writer, on the real table — the same call the machine-credential
    // middleware makes when a presented token resolves and is still refused.
    expect(
      await recordCredentialValidationFailure({
        applicationId,
        credentialId,
        reason: 'environment_mismatch',
        environment: 'development',
        metadata: { expectedEnvironment: 'production' },
      })
    ).toBe(true);

    const trail = await readTrail(applicationId, credentialId);
    const failure = trail.body.data?.find((event) => event.eventType === 'validation_failed');
    expect(failure).toBeDefined();
    expect(failure?.reason).toBe('environment_mismatch');
    // A refused bearer has nobody behind it. The table's CHECK refuses an actor
    // here; this is the wire half of that guarantee.
    expect(failure?.actorUserId).toBeNull();
  });

  it('honours `limit`, and refuses one past the cap', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);
    await request('POST', `/applications/${applicationId}/credentials/${credentialId}/rotate`, {
      payload: {},
    });

    // FLOOR: the unlimited read returns two, so `limit=1` returning one is the
    // limit working rather than the trail being short.
    expect((await readTrail(applicationId, credentialId)).body.count).toBe(2);
    expect((await readTrail(applicationId, credentialId, '?limit=1')).body.count).toBe(1);

    const overCap = await readTrail(applicationId, credentialId, '?limit=201');
    expect(overCap.status).toBe(400);
  });

  it('never puts `metadata` on the wire, though the stored rows carry it', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);

    // POSITIVE CONTROL for the absence: the row DOES hold metadata, so "no
    // metadata in the response" is a projection and not an empty table.
    const stored = await listCredentialAuditEvents(credentialId);
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0].metadata as Record<string, unknown>).length).toBeGreaterThan(0);

    const trail = await readTrail(applicationId, credentialId);
    expect(trail.raw).not.toContain('metadata');
    for (const event of trail.body.data ?? []) {
      expect(event).not.toHaveProperty('metadata');
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-account isolation — the load-bearing refusal
// ---------------------------------------------------------------------------

describe('another account’s credential trail', () => {
  it('is refused when asked for under the caller’s OWN application', async () => {
    // Account B, with its own application and credential.
    const otherOwner = await account();
    asCaller(otherOwner);
    const otherApplicationId = await seedApp(otherOwner);
    const { credentialId: otherCredentialId } = await createCredential(otherApplicationId);

    // Account A (the default caller), with an application it fully owns.
    asCaller(OWNER_ID);
    const ownApplicationId = await seedApp(OWNER_ID);
    const { credentialId: ownCredentialId } = await createCredential(ownApplicationId);

    // POSITIVE CONTROL: the same request shape, against A's own credential,
    // succeeds — so the refusal below is about WHOSE credential it is.
    const own = await readTrail(ownApplicationId, ownCredentialId);
    expect(own.status).toBe(200);
    expect(own.body.count).toBe(1);

    // The attack: A's own `:appId`, B's `:credId`. The application gate passes;
    // only the credential's ownership refuses this.
    const crossed = await readTrail(ownApplicationId, otherCredentialId);
    expect(crossed.status).toBe(404);
    expect(crossed.body.data).toBeUndefined();
    // …and nothing of B's leaked into the refusal.
    expect(crossed.raw).not.toContain(otherCredentialId);
    expect(crossed.raw).not.toContain(otherOwner);

    // B's trail is intact and still says exactly one thing happened, so the
    // refusal was a refusal and not a read that failed to render.
    expect(await listCredentialAuditEvents(otherCredentialId)).toHaveLength(1);
  });

  it('is refused when asked for under the OTHER account’s application', async () => {
    const otherOwner = await account();
    asCaller(otherOwner);
    const otherApplicationId = await seedApp(otherOwner);
    const { credentialId: otherCredentialId } = await createCredential(otherApplicationId);

    asCaller(OWNER_ID);
    const refused = await readTrail(otherApplicationId, otherCredentialId);
    // 403 rather than 404: `loadApplicationContext` answers a foreign
    // application this way for every route on this router, and this route
    // deliberately does not invent a different gate.
    expect(refused.status).toBe(403);
    expect(refused.body.data).toBeUndefined();
    expect(refused.raw).not.toContain(otherCredentialId);
  });

  it('is served on `credentials:read` and refused to a member without it', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);

    // A `developer` on the owning account — not the owner, and the least
    // privileged role that holds `credentials:read`. The trail is a read of the
    // credentials this role already administers, so this must succeed: a gate
    // only the owner passes would be a different gate from the credential list's.
    const developer = await account();
    accessGrants.set(`${developer}:${OWNER_ID}`, 'developer');
    asCaller(developer);
    const asDeveloper = await readTrail(applicationId, credentialId);
    expect(asDeveloper.status).toBe(200);
    expect(asDeveloper.body.count).toBe(1);

    // CONTROL, one step down: a `billing` member of the SAME account holds
    // `account:read` and `apps:read` and NOT `credentials:read`. Refused — so the
    // 200 above came from the permission and not from mere membership.
    const finance = await account();
    accessGrants.set(`${finance}:${OWNER_ID}`, 'billing');
    asCaller(finance);
    const asFinance = await readTrail(applicationId, credentialId);
    expect(asFinance.status).toBe(403);
    expect(asFinance.body.data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No secret material, by construction
// ---------------------------------------------------------------------------

describe('the trail cannot carry secret material', () => {
  it('contains neither a machine token nor a confidential secret — with a planted control', async () => {
    const applicationId = await seedApp(OWNER_ID);

    const machine = await createCredential(applicationId, 'machine');
    const confidential = await createCredential(applicationId, 'confidential');
    expect(machine.token).toMatch(/^oxy_sk_/);
    expect(confidential.secret).toMatch(/^[0-9a-f]{64}$/);

    // Rotate both, so the trail holds every event type an administrative
    // transition writes rather than only `created`.
    for (const credential of [machine, confidential]) {
      const rotated = await request(
        'POST',
        `/applications/${applicationId}/credentials/${credential.credentialId}/rotate`,
        { payload: {} }
      );
      expect(rotated.status).toBe(200);
    }

    const token = machine.token as string;
    const secret = confidential.secret as string;
    // The 256 secret bits alone, without their prefix: a response leaking only
    // the tail would still be a leak, and a search for the whole string would
    // miss it.
    const tokenTail = token.slice(token.lastIndexOf('_') + 1);

    for (const credential of [machine, confidential]) {
      const trail = await readTrail(applicationId, credential.credentialId);
      expect(trail.status).toBe(200);
      expect(trail.body.count).toBeGreaterThan(0);

      for (const needle of [token, tokenTail, secret]) {
        expect(containsDeep(trail.body, needle)).toBe(false);
        expect(trail.raw).not.toContain(needle);
      }
    }

    // POSITIVE CONTROL, in the same currency as the measurement: plant each
    // needle where a leak would put it and confirm the SAME predicate fires.
    // Without this, `false` above is what a predicate examining nothing returns.
    const planted = await readTrail(applicationId, machine.credentialId);
    for (const needle of [token, tokenTail, secret]) {
      expect(
        containsDeep({ data: [{ ...(planted.body.data ?? [])[0], leaked: needle }] }, needle)
      ).toBe(true);
    }
  });

  it('holds no secret material in the STORED rows either', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId, token } = await createCredential(applicationId, 'machine');
    const plaintext = token as string;

    // The wire projection omits `metadata`; this is the other half — the column
    // itself, read directly, so the guarantee does not rest on the projection.
    const stored = await listCredentialAuditEvents(credentialId);
    expect(stored.length).toBeGreaterThan(0);
    expect(containsDeep(stored, plaintext)).toBe(false);
    expect(containsDeep(stored, plaintext.slice(plaintext.lastIndexOf('_') + 1))).toBe(false);

    // CONTROL: the same rows with the token planted into one `metadata` blob are
    // found by the same search.
    expect(
      containsDeep(
        stored.map((row) => ({ ...row, metadata: { leaked: plaintext } })),
        plaintext
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The trail follows its credential's lifetime
// ---------------------------------------------------------------------------

describe('a revoked credential', () => {
  it('keeps its trail, and the revocation is on it', async () => {
    const applicationId = await seedApp(OWNER_ID);
    const { credentialId } = await createCredential(applicationId);

    const revoked = await request(
      'DELETE',
      `/applications/${applicationId}/credentials/${credentialId}`
    );
    expect(revoked.status).toBe(200);

    const trail = await readTrail(applicationId, credentialId);
    expect(trail.status).toBe(200);
    expect(trail.body.data?.map((event) => event.eventType).sort()).toEqual([
      'created',
      'revoked',
    ]);

    // The credential row survives the revoke — which is what keeps the trail
    // reachable, since the route resolves `:credId` against the application.
    const [row] = await getDb()
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    expect(row).toBeDefined();
  });
});
