/**
 * /applications routes — account-derived RBAC, credentials, redirect URIs, usage.
 *
 * Runs against the REAL Postgres the harness migrated, through the application's
 * own pool: what passes is what the shipped DDL and the shipped queries do
 * together. Only the two seams that are NOT the subject of these tests are
 * mocked — `account.service` (which grants the caller an effective account role,
 * and is still Mongoose-backed) and the auth middleware (which supplies the
 * caller identity).
 *
 * Access to an application is DERIVED from the caller's effective
 * `AccountMember` access over `app.ownerAccountId` (via
 * `appPermissionsForAccountAccess`); there is no per-app member table. The
 * fixtures here carry no per-member grants or revokes, so every case is the
 * role's plain baseline — the delta cases live in
 * `applicationPermissionOverrides.test.ts`, against the REAL account service.
 *
 * Every row is minted per test with a database-generated id, so no assertion
 * depends on a table being empty and test files may run in parallel against the
 * same database.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { eq, sql } from 'drizzle-orm';

// ONE pooled connection, so a `set time zone` issued from a test is the session
// the route's own query then runs on. That is what makes the UTC day-bucket
// assertion a real gate rather than a tautology: the CI and dev containers both
// run `Etc/UTC`, where a query that forgot to pin the zone is indistinguishable
// from one that pinned it.
process.env.PG_MAX_POOL_SIZE = '1';

import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

// --- account.service mock ---------------------------------------------------
// Grant the caller an effective account role per (userId, accountId). A caller
// over their own account is an implicit owner (mirrors the real service).

const accessGrants = new Map<string, AccountRole>();
function grantAccess(userId: string, accountId: string, role: AccountRole): void {
  accessGrants.set(`${userId}:${accountId}`, role);
}

function resolveRole(userId: string, accountId: string): AccountRole | undefined {
  if (userId === accountId) return 'owner';
  return accessGrants.get(`${userId}:${accountId}`);
}

const accountServiceMock = {
  resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) => {
    const role = resolveRole(userId, accountId);
    if (!role) return null;
    return {
      role,
      permissions: permissionsForAccountRole(role),
      source: userId === accountId ? 'self' : 'direct',
      membership: null,
    };
  }),
  listAccessibleAccounts: jest.fn(async (userId: string) => {
    const nodes: Array<Record<string, unknown>> = [
      { accountId: userId, relationship: 'self', callerMembership: null },
    ];
    for (const [key, role] of accessGrants) {
      const [u, accountId] = key.split(':');
      if (u === userId) {
        nodes.push({
          accountId,
          relationship: role === 'owner' ? 'owner' : 'member',
          // The real node carries the membership ROW, delta columns included —
          // the route resolves the effective permissions off it. A fake missing
          // them would throw inside the route rather than answer wrongly.
          callerMembership: {
            role,
            permissionGrants: [],
            permissionRevokes: [],
            source: 'direct',
            inherit: true,
          },
        });
      }
    }
    return nodes;
  }),
};

jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: accountServiceMock,
}));

const mockAuthMiddleware = jest.fn();
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

// The CORS origin snapshot is rebuilt fire-and-forget after every application
// write and is still Mongoose-backed; stub it so these tests exercise the route,
// not the registry.
const mockRefreshOriginRegistry = jest.fn(async () => {});
jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: () => mockRefreshOriginRegistry(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { apiKeyUsageEvents, applicationCredentials, applications, users } from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: Record<string, unknown> & {
    application?: Record<string, unknown>;
    applications?: Array<Record<string, unknown>>;
    credential?: Record<string, unknown>;
    credentials?: Array<Record<string, unknown>>;
    summary?: Record<string, number>;
    byDay?: Array<Record<string, unknown>>;
    byEndpoint?: Array<Record<string, unknown>>;
    secret?: string | null;
    rotatedFrom?: string;
    success?: boolean;
    error?: string;
    message?: string;
  };
}

async function requestJson(
  srv: http.Server,
  method: string,
  path: string,
  payload?: unknown
): Promise<JsonResponse> {
  const address = srv.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
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
          Authorization: 'Bearer t',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;
let currentUserId = '';
let currentIsStaff = false;

/** Ids minted fresh per test — see the file header. */
let OWNER_ID = '';
let OTHER_ID = '';
let ORG_ID = '';

function actAs(userId: string, isStaff = false): void {
  currentUserId = userId;
  currentIsStaff = isStaff;
}

/** A real `users` row, standing in for an account in the account graph. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** A real `applications` row owned by `OWNER_ID` unless overridden. */
async function seedApp(
  overrides: Partial<typeof applications.$inferInsert> = {}
): Promise<typeof applications.$inferSelect> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: 'Seed App',
      ownerAccountId: OWNER_ID,
      createdByUserId: OWNER_ID,
      ...overrides,
    })
    .returning();
  return row;
}

/** A real `application_credentials` row on `applicationId`. */
async function seedCredential(
  applicationId: string,
  overrides: Partial<typeof applicationCredentials.$inferInsert> = {}
): Promise<typeof applicationCredentials.$inferSelect> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'Cred',
      publicKey: `oxy_dk_${crypto.randomBytes(12).toString('hex')}`,
      secretHash: 'hash',
      type: 'confidential',
      environment: 'production',
      createdByUserId: OWNER_ID,
      ...overrides,
    })
    .returning();
  return row;
}

/** Re-read an application straight from the database. */
async function readApp(id: string): Promise<typeof applications.$inferSelect | undefined> {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id)).limit(1);
  return row;
}

/** Re-read a credential straight from the database. */
async function readCredential(
  id: string
): Promise<typeof applicationCredentials.$inferSelect | undefined> {
  const [row] = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, id))
    .limit(1);
  return row;
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
  [OWNER_ID, OTHER_ID, ORG_ID] = await Promise.all([account(), account(), account()]);
  actAs(OWNER_ID, false);
  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: { toString: () => currentUserId }, isStaff: currentIsStaff };
      next();
    }
  );
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /applications — create', () => {
  it('defaults ownerAccountId to the caller and embeds callerMembership', async () => {
    const res = await requestJson(server, 'POST', '/applications', { name: 'My App' });
    expect(res.status).toBe(201);
    expect(res.body.application?.ownerAccountId).toBe(OWNER_ID);
    expect((res.body.application?.callerMembership as Record<string, unknown>)?.role).toBe('owner');
  });

  it('binds to an explicit ownerAccountId the caller can create apps in', async () => {
    grantAccess(OWNER_ID, ORG_ID, 'admin');
    const res = await requestJson(server, 'POST', '/applications', {
      ownerAccountId: ORG_ID,
      name: 'Org App',
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.ownerAccountId).toBe(ORG_ID);
  });

  it('403 when the caller has no access to the owning account', async () => {
    const res = await requestJson(server, 'POST', '/applications', {
      ownerAccountId: ORG_ID,
      name: 'Nope',
    });
    expect(res.status).toBe(403);
  });

  it('403 when the caller lacks apps:create (viewer)', async () => {
    grantAccess(OWNER_ID, ORG_ID, 'viewer');
    const res = await requestJson(server, 'POST', '/applications', {
      ownerAccountId: ORG_ID,
      name: 'Nope',
    });
    expect(res.status).toBe(403);
  });

  it('403 — not 400 — when ownerAccountId names no account at all', async () => {
    // An id has no format to be "malformed" against any more: `ownerAccountId`
    // is `text`. An id nobody has access to is a 403 whether or not a row
    // exists, and nothing leaks which of the two it was.
    const res = await requestJson(server, 'POST', '/applications', {
      ownerAccountId: 'no-such-account',
      name: 'Bad',
    });
    expect(res.status).toBe(403);
  });

  it('de-duplicates redirectUris preserving order and exact strings', async () => {
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'R',
      redirectUris: ['https://a.com/cb', 'https://a.com/cb', 'https://b.com/cb'],
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.redirectUris).toEqual(['https://a.com/cb', 'https://b.com/cb']);
  });

  it('403 when a non-staff creator self-grants a privileged scope', async () => {
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Priv',
      scopes: ['federation:write'],
    });
    expect(res.status).toBe(403);
  });

  it('allows a STAFF creator to grant a privileged scope', async () => {
    actAs(OWNER_ID, true);
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Priv',
      scopes: ['federation:write'],
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.scopes).toContain('federation:write');
  });

  /**
   * The inference classification (#972 workstream 3) reaching the write path,
   * not just the constant: `inference:providers:write` manages provider/BYOK
   * connections and `inference:routing:write` decides where requests are served
   * from, so neither is self-grantable — while the five reads and the invoke
   * are, and an ordinary owner must not need staff to build against inference.
   */
  it('403 when a non-staff creator self-grants an inference WRITE scope', async () => {
    for (const scope of ['inference:providers:write', 'inference:routing:write']) {
      const res = await requestJson(server, 'POST', '/applications', {
        name: `Inference ${scope}`,
        scopes: ['inference:invoke', scope],
      });
      expect(res.status).toBe(403);
    }
  });

  it('lets a non-staff creator self-grant the whole non-privileged inference family', async () => {
    // The control for the refusal above. Without it, a create path that had
    // broken into 403-ing every inference scope would look like correct
    // staff-gating.
    const selfGrantable = [
      'inference:invoke',
      'inference:models:read',
      'inference:usage:read',
      'inference:routing:read',
      'inference:providers:read',
    ];
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Inference reader',
      scopes: selfGrantable,
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.scopes).toEqual(selfGrantable);
  });

  it('allows a STAFF creator to grant an inference WRITE scope', async () => {
    actAs(OWNER_ID, true);
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'BYOK manager',
      scopes: ['inference:providers:write'],
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.scopes).toContain('inference:providers:write');
  });

  it('400s a retired scope name outright — there is no alias', async () => {
    // The clean cut, at the request boundary: `chat:completions` is no longer
    // in the Zod enum, so it is rejected as an unknown value rather than
    // silently translated to `inference:invoke`.
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Legacy',
      scopes: ['chat:completions'],
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Legal URLs (privacyPolicyUrl / termsUrl) — OAuth consent links
// ---------------------------------------------------------------------------

describe('privacyPolicyUrl / termsUrl — legal consent links', () => {
  it('create persists and serializes both legal URLs', async () => {
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Legal App',
      privacyPolicyUrl: 'https://example.com/privacy',
      termsUrl: 'https://example.com/terms',
    });
    expect(res.status).toBe(201);
    expect(res.body.application?.privacyPolicyUrl).toBe('https://example.com/privacy');
    expect(res.body.application?.termsUrl).toBe('https://example.com/terms');

    const stored = await readApp(res.body.application?._id as string);
    expect(stored?.privacyPolicyUrl).toBe('https://example.com/privacy');
    expect(stored?.termsUrl).toBe('https://example.com/terms');
  });

  it('PATCH updates both legal URLs and serializes them', async () => {
    const app = await seedApp();
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      privacyPolicyUrl: 'https://acme.example/privacy',
      termsUrl: 'https://acme.example/terms',
    });
    expect(res.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.privacyPolicyUrl).toBe('https://acme.example/privacy');
    expect(stored?.termsUrl).toBe('https://acme.example/terms');
    expect(res.body.application?.privacyPolicyUrl).toBe('https://acme.example/privacy');
    expect(res.body.application?.termsUrl).toBe('https://acme.example/terms');
  });

  it('PATCH clears a legal URL with an empty string, and the key is then ABSENT', async () => {
    const app = await seedApp({ privacyPolicyUrl: 'https://example.com/privacy' });
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      privacyPolicyUrl: '',
    });
    expect(res.status).toBe(200);
    expect((await readApp(app.id))?.privacyPolicyUrl).toBeNull();
    // A cleared column is NULL in the database and must not surface as an
    // explicit `null` on the wire — Mongo omitted the key, and so does this.
    expect(res.body.application).not.toHaveProperty('privacyPolicyUrl');
  });

  it('400 when a legal URL is not a valid URL', async () => {
    const app = await seedApp();
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      privacyPolicyUrl: 'not-a-url',
    });
    expect(res.status).toBe(400);
  });

  it('400 when a legal URL is not https (http rejected on create)', async () => {
    const res = await requestJson(server, 'POST', '/applications', {
      name: 'Insecure',
      termsUrl: 'http://example.com/terms',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Read / update / delete RBAC
// ---------------------------------------------------------------------------

describe('GET/PATCH/DELETE /applications/:appId — account-derived RBAC', () => {
  it('owner can read its own app', async () => {
    const app = await seedApp();
    const res = await requestJson(server, 'GET', `/applications/${app.id}`);
    expect(res.status).toBe(200);
    expect(res.body.application?._id).toBe(app.id);
  });

  it('404 for a non-existent application', async () => {
    const res = await requestJson(server, 'GET', '/applications/no-such-application');
    expect(res.status).toBe(404);
  });

  it('404 for a soft-deleted application', async () => {
    const app = await seedApp({ status: 'deleted' });
    const res = await requestJson(server, 'GET', `/applications/${app.id}`);
    expect(res.status).toBe(404);
  });

  it('403 when the caller has no access to the owning account', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    actAs(OTHER_ID);
    const res = await requestJson(server, 'GET', `/applications/${app.id}`);
    expect(res.status).toBe(403);
  });

  it('a viewer cannot update (no app:update)', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    actAs(OTHER_ID);
    grantAccess(OTHER_ID, ORG_ID, 'viewer');
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, { name: 'X' });
    expect(res.status).toBe(403);
  });

  it('an editor can update but cannot delete', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    actAs(OTHER_ID);
    grantAccess(OTHER_ID, ORG_ID, 'editor');

    const patch = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      name: 'Renamed',
    });
    expect(patch.status).toBe(200);
    expect((await readApp(app.id))?.name).toBe('Renamed');

    const del = await requestJson(server, 'DELETE', `/applications/${app.id}`);
    expect(del.status).toBe(403);
  });

  it('an admin can delete (soft-delete)', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    actAs(OTHER_ID);
    grantAccess(OTHER_ID, ORG_ID, 'admin');
    const res = await requestJson(server, 'DELETE', `/applications/${app.id}`);
    expect(res.status).toBe(200);
    expect((await readApp(app.id))?.status).toBe('deleted');
  });

  it('PATCH writes only the fields the caller supplied', async () => {
    const app = await seedApp({ description: 'kept', websiteUrl: 'https://kept.example' });
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, { name: 'Only' });
    expect(res.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.name).toBe('Only');
    expect(stored?.description).toBe('kept');
    expect(stored?.websiteUrl).toBe('https://kept.example');
  });

  it('PATCH rotates the webhook secret only when the webhook URL actually changes', async () => {
    const app = await seedApp({
      webhookUrl: 'https://hook.example/a',
      webhookSecret: 'original-secret',
    });

    const unchanged = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      webhookUrl: 'https://hook.example/a',
    });
    expect(unchanged.status).toBe(200);
    expect((await readApp(app.id))?.webhookSecret).toBe('original-secret');

    const changed = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      webhookUrl: 'https://hook.example/b',
    });
    expect(changed.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.webhookUrl).toBe('https://hook.example/b');
    expect(stored?.webhookSecret).not.toBe('original-secret');
    // The webhook secret is server-only and must never be serialized.
    expect(changed.body.application).not.toHaveProperty('webhookSecret');
  });
});

// ---------------------------------------------------------------------------
// PATCH scopes — privileged-scope reconciliation
//
// Regression coverage for the root cause of Mention losing its granted, in-use
// `signals:write` scope: `PATCH /:appId` replaces `application.scopes` with the
// submitted array, so a non-staff caller submitting a stale/partial scope list
// (e.g. a console scope-picker whose canonical options omit a newly-added
// privileged scope) MUST NOT silently revoke an already-granted privileged
// scope. Non-staff callers can neither add nor drop privileged scopes.
// ---------------------------------------------------------------------------

describe('PATCH /applications/:appId — privileged scope reconciliation', () => {
  it('preserves an already-granted privileged scope a non-staff owner omits', async () => {
    const app = await seedApp({ scopes: ['user:read', 'files:write', 'signals:write'] });

    // Simulates the console form re-submitting a canonical list that includes a
    // newly-added non-privileged scope (files:read) but drops signals:write.
    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      scopes: ['user:read', 'files:write', 'files:read'],
    });

    expect(res.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.scopes).toContain('signals:write');
    expect(stored?.scopes).toEqual(
      expect.arrayContaining(['user:read', 'files:write', 'files:read', 'signals:write'])
    );
    expect(res.body.application?.scopes).toContain('signals:write');
  });

  it('preserves multiple already-granted privileged scopes on a scope edit', async () => {
    const app = await seedApp({ scopes: ['user:read', 'signals:write', 'federation:write'] });

    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      scopes: ['user:read'],
    });

    expect(res.status).toBe(200);
    expect((await readApp(app.id))?.scopes).toEqual(
      expect.arrayContaining(['user:read', 'signals:write', 'federation:write'])
    );
  });

  it('still rejects a non-staff caller adding a new privileged scope', async () => {
    const app = await seedApp({ scopes: ['user:read'] });

    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      scopes: ['user:read', 'signals:write'],
    });

    expect(res.status).toBe(403);
  });

  it('lets a STAFF caller intentionally revoke a privileged scope', async () => {
    actAs(OWNER_ID, true);
    const app = await seedApp({ scopes: ['user:read', 'signals:write'] });

    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      scopes: ['user:read'],
    });

    expect(res.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.scopes).not.toContain('signals:write');
    expect(stored?.scopes).toEqual(['user:read']);
  });

  it('does not duplicate a privileged scope the non-staff caller kept', async () => {
    const app = await seedApp({ scopes: ['user:read', 'signals:write'] });

    const res = await requestJson(server, 'PATCH', `/applications/${app.id}`, {
      scopes: ['user:read', 'signals:write'],
    });

    expect(res.status).toBe(200);
    const stored = await readApp(app.id);
    expect(stored?.scopes.filter((s) => s === 'signals:write')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /applications — list', () => {
  it('lists apps across the accessible account forest, newest first', async () => {
    const mine = await seedApp({ name: 'Mine' });
    const theirs = await seedApp({ name: 'Theirs', ownerAccountId: ORG_ID });
    grantAccess(OWNER_ID, ORG_ID, 'developer');

    const res = await requestJson(server, 'GET', '/applications');
    expect(res.status).toBe(200);
    const ids = (res.body.applications ?? []).map((a) => a._id);
    expect(ids).toEqual([theirs.id, mine.id]);
  });

  it('excludes a soft-deleted application', async () => {
    const live = await seedApp({ name: 'Live' });
    await seedApp({ name: 'Gone', status: 'deleted' });

    const res = await requestJson(server, 'GET', '/applications');
    expect(res.status).toBe(200);
    expect((res.body.applications ?? []).map((a) => a._id)).toEqual([live.id]);
  });

  it('?ownerAccountId= scopes to one account the caller can access', async () => {
    await seedApp();
    const orgApp = await seedApp({ ownerAccountId: ORG_ID });
    grantAccess(OWNER_ID, ORG_ID, 'admin');
    const res = await requestJson(server, 'GET', `/applications?ownerAccountId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect((res.body.applications ?? []).map((a) => a._id)).toEqual([orgApp.id]);
    expect(res.body.applications?.[0].ownerAccountId).toBe(ORG_ID);
  });

  it('403 when ?ownerAccountId= names an account the caller cannot access', async () => {
    const res = await requestJson(server, 'GET', `/applications?ownerAccountId=${ORG_ID}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credentials', () => {
  it('create returns the secret exactly once; read never exposes it', async () => {
    const app = await seedApp({ scopes: ['user:read'] });
    const created = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'CI',
      type: 'confidential',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.credential).not.toHaveProperty('secretHash');

    // Only the hash is persisted, and it is the hash of the secret returned once.
    const stored = await readCredential(created.body.credential?._id as string);
    expect(stored?.secretHash).toBe(
      crypto.createHash('sha256').update(created.body.secret as string).digest('hex')
    );

    const list = await requestJson(server, 'GET', `/applications/${app.id}/credentials`);
    expect(list.status).toBe(200);
    expect(list.body.credentials?.[0]).not.toHaveProperty('secretHash');
    expect(list.body.credentials?.[0]).not.toHaveProperty('secret');
  });

  it('a public credential carries no secret', async () => {
    const app = await seedApp();
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'pub',
      type: 'public',
      environment: 'production',
    });
    expect(res.status).toBe(201);
    expect(res.body.secret).toBeNull();
    expect((await readCredential(res.body.credential?._id as string))?.secretHash).toBeNull();
  });

  it('rejects a service credential on a non-trusted application', async () => {
    const app = await seedApp({ type: 'third_party', isOfficial: false, isInternal: false });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'svc',
      type: 'service',
      environment: 'production',
    });
    expect(res.status).toBe(403);
  });

  it('the Oxy Pay carve-out lets a non-trusted app create a payments-only service credential', async () => {
    const app = await seedApp({
      type: 'third_party',
      isOfficial: false,
      isInternal: false,
      scopes: ['payments:read', 'payments:write'],
    });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'oxy-pay-svc',
      type: 'service',
      environment: 'production',
      scopes: ['payments:read', 'payments:write'],
    });
    expect(res.status).toBe(201);
    expect(res.body.credential?.scopes).toEqual(['payments:read', 'payments:write']);
  });

  it('the Oxy Pay carve-out still rejects a non-trusted app requesting any non-payments scope', async () => {
    const app = await seedApp({
      type: 'third_party',
      isOfficial: false,
      isInternal: false,
      scopes: ['payments:read', 'user:read'],
    });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'svc',
      type: 'service',
      environment: 'production',
      scopes: ['payments:read', 'user:read'],
    });
    expect(res.status).toBe(403);
  });

  it('requires a trusted service credential to name at least one scope', async () => {
    const app = await seedApp({
      type: 'internal',
      isOfficial: false,
      isInternal: false,
      scopes: ['user:read'],
    });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'svc',
      type: 'service',
      environment: 'production',
    });
    expect(res.status).toBe(400);
  });

  it('lets a trusted application create a service credential with explicit scopes', async () => {
    const app = await seedApp({
      type: 'internal',
      isOfficial: false,
      isInternal: false,
      scopes: ['user:read'],
    });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'svc',
      type: 'service',
      environment: 'production',
      scopes: ['user:read'],
    });
    expect(res.status).toBe(201);
  });

  it('rejects credential scopes that exceed the application grant', async () => {
    const app = await seedApp({ scopes: ['user:read'] });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'over',
      type: 'confidential',
      environment: 'production',
      scopes: ['federation:write'],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a credential naming inference:providers:write on an app without it', async () => {
    // The escalation refused one step earlier than the mint: a credential row
    // that could hold the scope is never created in the first place.
    const app = await seedApp({ scopes: ['inference:invoke', 'inference:providers:read'] });
    const res = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'byok',
      type: 'confidential',
      environment: 'production',
      scopes: ['inference:invoke', 'inference:providers:write'],
    });
    expect(res.status).toBe(400);

    // …and the same request minus that one scope is accepted, so the refusal is
    // about the ungranted scope rather than about inference credentials.
    const allowed = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'reader',
      type: 'confidential',
      environment: 'production',
      scopes: ['inference:invoke', 'inference:providers:read'],
    });
    expect(allowed.status).toBe(201);
  });

  it('403s a credential create on an application in an account the caller cannot reach', async () => {
    // Cross-account: the app genuinely holds the inference grant, and the
    // caller is simply not a member of the account that owns it — so nothing
    // about the scope makes the credential reachable.
    const foreign = await seedApp({
      ownerAccountId: ORG_ID,
      // Both halves, so the subset check is satisfied either way and the only
      // thing that can refuse a request below is an authorization decision.
      scopes: ['inference:invoke', 'inference:providers:read', 'inference:providers:write'],
    });
    // The scope here is deliberately the READ. `inference:providers:write` is
    // staff-only on this path as well (asserted below), and using it for the
    // boundary case would conflate the two refusals.
    const res = await requestJson(server, 'POST', `/applications/${foreign.id}/credentials`, {
      name: 'stolen',
      type: 'confidential',
      environment: 'production',
      scopes: ['inference:providers:read'],
    });
    expect(res.status).toBe(403);

    // Control: the identical request succeeds once the caller IS a member with
    // credential-create permission, so the 403 is the account boundary.
    grantAccess(OWNER_ID, ORG_ID, 'developer');
    const allowed = await requestJson(server, 'POST', `/applications/${foreign.id}/credentials`, {
      name: 'legitimate',
      type: 'confidential',
      environment: 'production',
      scopes: ['inference:providers:read'],
    });
    expect(allowed.status).toBe(201);

    // …and that same member is still refused the PRIVILEGED half, for a DIFFERENT
    // reason: a scope staff granted the application is not a scope a member may
    // put on a new long-lived credential of their own (issue #972 §3). The two
    // 403s are distinguished by their message, so neither can be mistaken for the
    // other.
    const escalation = await requestJson(
      server,
      'POST',
      `/applications/${foreign.id}/credentials`,
      {
        name: 'escalation',
        type: 'confidential',
        environment: 'production',
        scopes: ['inference:providers:write'],
      }
    );
    expect(escalation.status).toBe(403);
    expect(escalation.body.message).toContain('staff');
    expect(res.body.message).not.toContain('staff');

    // Control: staff may mint it. Same member, same application, same body — so
    // the refusal above is the staff gate and not the credential route failing.
    actAs(OWNER_ID, true);
    const asStaff = await requestJson(server, 'POST', `/applications/${foreign.id}/credentials`, {
      name: 'staff-minted',
      type: 'confidential',
      environment: 'production',
      scopes: ['inference:providers:write'],
    });
    expect(asStaff.status).toBe(201);
  });

  it('rotate mints a new credential and deprecates the previous one', async () => {
    const app = await seedApp();
    const previous = await seedCredential(app.id, { type: 'confidential' });
    const res = await requestJson(
      server,
      'POST',
      `/applications/${app.id}/credentials/${previous.id}/rotate`
    );
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.rotatedFrom).toBe(previous.id);

    const storedPrevious = await readCredential(previous.id);
    expect(storedPrevious?.status).toBe('deprecated');
    expect(storedPrevious?.expiresAt).toBeInstanceOf(Date);

    // The mint and the deprecation are one transaction, so the new credential
    // exists exactly when the old one has been retired — and it links back.
    const minted = await readCredential(res.body.credential?._id as string);
    expect(minted?.status).toBe('active');
    expect(minted?.rotatedFromCredentialId).toBe(previous.id);
    expect(minted?.publicKey).not.toBe(previous.publicKey);
  });

  it('rotate 404s for a credential belonging to another application, changing nothing', async () => {
    const app = await seedApp();
    const other = await seedApp({ name: 'Other' });
    const foreign = await seedCredential(other.id);

    const res = await requestJson(
      server,
      'POST',
      `/applications/${app.id}/credentials/${foreign.id}/rotate`
    );
    expect(res.status).toBe(404);
    expect((await readCredential(foreign.id))?.status).toBe('active');
    const minted = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, app.id));
    expect(minted).toHaveLength(0);
  });

  it('rotate refuses a public credential without minting a replacement', async () => {
    const app = await seedApp();
    const pub = await seedCredential(app.id, { type: 'public', secretHash: null });
    const res = await requestJson(
      server,
      'POST',
      `/applications/${app.id}/credentials/${pub.id}/rotate`
    );
    expect(res.status).toBe(400);
    expect((await readCredential(pub.id))?.status).toBe('active');
    const all = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, app.id));
    expect(all).toHaveLength(1);
  });

  it('revoke marks the credential revoked', async () => {
    const app = await seedApp();
    const credential = await seedCredential(app.id);
    const res = await requestJson(
      server,
      'DELETE',
      `/applications/${app.id}/credentials/${credential.id}`
    );
    expect(res.status).toBe(200);
    expect((await readCredential(credential.id))?.status).toBe('revoked');
  });

  it('revoke 404s for a credential belonging to another application, changing nothing', async () => {
    const app = await seedApp();
    const other = await seedApp({ name: 'Other' });
    const foreign = await seedCredential(other.id);

    const res = await requestJson(
      server,
      'DELETE',
      `/applications/${app.id}/credentials/${foreign.id}`
    );
    expect(res.status).toBe(404);
    expect((await readCredential(foreign.id))?.status).toBe('active');
  });

  it('a developer can manage credentials but a viewer cannot', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    actAs(OTHER_ID);
    grantAccess(OTHER_ID, ORG_ID, 'viewer');
    const viewerRes = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'x',
      type: 'confidential',
      environment: 'production',
    });
    expect(viewerRes.status).toBe(403);

    grantAccess(OTHER_ID, ORG_ID, 'developer');
    const devRes = await requestJson(server, 'POST', `/applications/${app.id}/credentials`, {
      name: 'ok',
      type: 'confidential',
      environment: 'production',
    });
    expect(devRes.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('GET /applications/:appId/usage', () => {
  /** A served request recorded against `applicationId` at `createdAt`. */
  async function usageEvent(
    applicationId: string,
    values: Partial<typeof apiKeyUsageEvents.$inferInsert>
  ): Promise<void> {
    await getDb()
      .insert(apiKeyUsageEvents)
      .values({
        applicationId,
        userId: OWNER_ID,
        endpoint: '/v1/thing',
        method: 'GET',
        statusCode: 200,
        ...values,
      });
  }

  it('aggregates totals, the success/error split, and the per-endpoint top list', async () => {
    const app = await seedApp();
    const now = new Date();
    await usageEvent(app.id, {
      endpoint: '/v1/a',
      statusCode: 200,
      tokensUsed: 10,
      creditsUsed: 1.5,
      responseTime: 100,
      createdAt: now,
    });
    await usageEvent(app.id, {
      endpoint: '/v1/a',
      statusCode: 201,
      tokensUsed: 5,
      creditsUsed: 0.5,
      responseTime: 300,
      createdAt: now,
    });
    await usageEvent(app.id, {
      endpoint: '/v1/b',
      statusCode: 500,
      tokensUsed: 1,
      creditsUsed: 0,
      responseTime: 200,
      createdAt: now,
    });

    const res = await requestJson(server, 'GET', `/applications/${app.id}/usage?period=7d`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRequests: 3,
      totalTokens: 16,
      totalCredits: 2,
      avgResponseTime: 200,
      successfulRequests: 2,
      errorRequests: 1,
    });
    // Integer sums come back from `bigint` and must be numbers, not strings.
    expect(typeof res.body.summary?.totalTokens).toBe('number');

    expect(res.body.byEndpoint).toEqual([
      { _id: '/v1/a', requests: 2, tokens: 15 },
      { _id: '/v1/b', requests: 1, tokens: 1 },
    ]);
  });

  it('buckets byDay on the UTC day even when the session time zone is not UTC', async () => {
    const app = await seedApp();
    // 30 minutes either side of the most recent UTC midnight: one calendar day
    // apart in UTC, and the SAME local day anywhere west of Greenwich.
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const before = new Date(utcMidnight.getTime() - 30 * 60 * 1000);
    const after = new Date(utcMidnight.getTime() + 30 * 60 * 1000);
    await usageEvent(app.id, { createdAt: before, tokensUsed: 2 });
    await usageEvent(app.id, { createdAt: after, tokensUsed: 3 });

    // The pool holds exactly one connection (see the top of this file), so this
    // IS the session the route's query runs on. In America/Los_Angeles both
    // instants fall on the same local day, so a `to_char` that did not pin the
    // zone would collapse them into one bucket.
    await getDb().execute(sql`set time zone 'America/Los_Angeles'`);
    try {
      const res = await requestJson(server, 'GET', `/applications/${app.id}/usage?period=7d`);
      expect(res.status).toBe(200);
      expect(res.body.byDay).toEqual([
        { _id: before.toISOString().slice(0, 10), requests: 1, tokens: 2, credits: 0 },
        { _id: after.toISOString().slice(0, 10), requests: 1, tokens: 3, credits: 0 },
      ]);
    } finally {
      await getDb().execute(sql`set time zone 'UTC'`);
    }
  });

  it('excludes events outside the requested window and events of other apps', async () => {
    const app = await seedApp();
    const other = await seedApp({ name: 'Other' });
    await usageEvent(app.id, { createdAt: new Date() });
    await usageEvent(app.id, { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
    await usageEvent(other.id, { createdAt: new Date() });

    const res = await requestJson(server, 'GET', `/applications/${app.id}/usage?period=7d`);
    expect(res.status).toBe(200);
    expect(res.body.summary?.totalRequests).toBe(1);
  });

  it('reports zeroes for an application with no usage at all', async () => {
    const app = await seedApp();
    const res = await requestJson(server, 'GET', `/applications/${app.id}/usage`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      avgResponseTime: 0,
      successfulRequests: 0,
      errorRequests: 0,
    });
    expect(res.body.byDay).toEqual([]);
    expect(res.body.byEndpoint).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Foreign keys the port now enforces
// ---------------------------------------------------------------------------

describe('ownership integrity', () => {
  it('deleting the owning account deletes its applications and their credentials', async () => {
    const app = await seedApp({ ownerAccountId: ORG_ID });
    const credential = await seedCredential(app.id);

    await getDb().delete(users).where(eq(users.id, ORG_ID));

    expect(await readApp(app.id)).toBeUndefined();
    expect(await readCredential(credential.id)).toBeUndefined();
  });

  it('deleting the CREATOR keeps the application, dropping only the attribution', async () => {
    const creator = await account();
    const app = await seedApp({ ownerAccountId: ORG_ID, createdByUserId: creator });

    await getDb().delete(users).where(eq(users.id, creator));

    const stored = await readApp(app.id);
    expect(stored?.createdByUserId).toBeNull();
    expect(stored?.ownerAccountId).toBe(ORG_ID);
  });

  it('serializes a null creator as an ABSENT key, never an explicit null', async () => {
    const creator = await account();
    const app = await seedApp({ createdByUserId: creator });
    await getDb().delete(users).where(eq(users.id, creator));

    const res = await requestJson(server, 'GET', `/applications/${app.id}`);
    expect(res.status).toBe(200);
    expect(res.body.application).not.toHaveProperty('createdByUserId');
  });
});
