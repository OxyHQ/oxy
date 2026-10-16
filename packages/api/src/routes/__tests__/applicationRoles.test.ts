import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
/**
 * Application roles end to end: the router, the real account-graph RBAC, the
 * real service and a real Postgres. Only caller identity is stubbed — the auth
 * middleware (the SUBJECT the bearer speaks as, plus its session binding) and
 * `resolveOperatorId` (the HUMAN behind it) — so each case can say exactly who
 * is asking and as whom.
 *
 * Every refusal is paired with a control that differs in ONE thing, so a 403
 * from a fixture that never reached the gate cannot pass for the gate firing.
 */

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';

let currentSubjectId = '';
let currentOperatorId = '';
let currentBoundApplicationId: string | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: {
      user?: { _id: string; id: string };
      oxyToken?: { applicationId: string | null };
      sessionId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: currentSubjectId, id: currentSubjectId };
    req.oxyToken = { applicationId: currentBoundApplicationId };
    next();
  },
}));

jest.mock('../../middleware/operator', () => ({
  resolveOperatorId: async () => currentOperatorId,
  resolveSubjectId: () => currentSubjectId,
}));

jest.mock('../../middleware/requireStaff', () => ({
  isStaffUser: () => false,
}));

jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import {
  applicationRoleGrants,
  applicationRolePermissions,
  applications,
  users,
} from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';
import type { AccountRole } from '../../utils/accountRoles';

let server: http.Server;

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
  body: any;
}

function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
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
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Act as `operator`, speaking as `subject` (the same person unless acting as an org). */
function actAs(operator: string, subject: string = operator): void {
  currentOperatorId = operator;
  currentSubjectId = subject;
}

async function seedAccount(
  kind: 'personal' | 'organization' | 'bot' = 'personal',
): Promise<{ id: string; username: string }> {
  const username = `roles-${crypto.randomBytes(6).toString('hex')}`;
  const [row] = await insertAccountFixtures({ username, kind }, { id: users.id });
  return { id: row.id, username };
}

async function seedMember(accountId: string, memberUserId: string, role: AccountRole) {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId, role, inherit: true, status: 'active' });
}

async function seedApp(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Roles App', ownerAccountId, createdByUserId: ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

const MERCARIA_VOCABULARY = [
  { key: 'payments.operate', description: 'Run the payments desk' },
  { key: 'catalog.operate', description: 'Reshape the canonical catalogue' },
  { key: 'guest.operate', description: 'Operate guest commerce' },
];

/** An organization owning an app, with an owner, an admin, a viewer and an outsider. */
async function seedOrg() {
  const org = await seedAccount('organization');
  const owner = await seedAccount();
  const admin = await seedAccount();
  const secondAdmin = await seedAccount();
  const viewer = await seedAccount();
  const outsider = await seedAccount();
  await seedMember(org.id, owner.id, 'owner');
  await seedMember(org.id, admin.id, 'admin');
  await seedMember(org.id, secondAdmin.id, 'admin');
  await seedMember(org.id, viewer.id, 'viewer');
  const appId = await seedApp(org.id);
  return { org, owner, admin, secondAdmin, viewer, outsider, appId };
}

async function declare(appId: string, permissions = MERCARIA_VOCABULARY) {
  return request('PUT', `/applications/${appId}/roles/permissions`, { permissions });
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/applications', applicationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
});

beforeEach(() => {
  currentBoundApplicationId = null;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('declaring the vocabulary', () => {
  it('an admin declares; a viewer reads but may not declare; an outsider may not read', async () => {
    const { admin, viewer, outsider, appId } = await seedOrg();

    actAs(viewer.id);
    const refused = await declare(appId);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('roles:manage');

    actAs(admin.id);
    const declared = await declare(appId);
    expect(declared.status).toBe(200);
    expect(declared.body.added).toEqual(['payments.operate', 'catalog.operate', 'guest.operate']);
    expect(declared.body.items.map((item: { key: string }) => item.key)).toEqual([
      'catalog.operate',
      'guest.operate',
      'payments.operate',
    ]);
    expect(declared.body.items[0].declaredByUserId).toBe(admin.id);

    actAs(viewer.id);
    const read = await request('GET', `/applications/${appId}/roles/permissions`);
    expect(read.status).toBe(200);
    expect(read.body.items).toHaveLength(3);

    actAs(outsider.id);
    expect((await request('GET', `/applications/${appId}/roles/permissions`)).status).toBe(403);
  });

  it('is idempotent, re-describes in place and refuses a colon-spelled key', async () => {
    const { admin, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);
    const again = await declare(appId);
    expect(again.body).toMatchObject({ added: [], retired: [], described: [], revokedGrants: 0 });

    const before = await getDb()
      .select({ id: applicationRolePermissions.id })
      .from(applicationRolePermissions)
      .where(
        and(
          eq(applicationRolePermissions.applicationId, appId),
          eq(applicationRolePermissions.key, 'payments.operate'),
        ),
      );
    const redescribed = await declare(appId, [
      { key: 'payments.operate', description: 'Decide customer remedies' },
      ...MERCARIA_VOCABULARY.slice(1),
    ]);
    expect(redescribed.body.described).toEqual(['payments.operate']);
    const after = await getDb()
      .select({
        id: applicationRolePermissions.id,
        description: applicationRolePermissions.description,
      })
      .from(applicationRolePermissions)
      .where(
        and(
          eq(applicationRolePermissions.applicationId, appId),
          eq(applicationRolePermissions.key, 'payments.operate'),
        ),
      );
    // Same row: grants hang off it and must not move.
    expect(after).toEqual([{ id: before[0]?.id, description: 'Decide customer remedies' }]);

    const colon = await declare(appId, [{ key: 'payments:operate', description: 'x' }]);
    expect(colon.status).toBe(400);
  });
});

describe('granting, reading and revoking', () => {
  it('a grant reaches roles/me at once, and a revocation leaves it at once', async () => {
    const { admin, outsider, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);

    // The control: before the grant the person holds nothing.
    actAs(outsider.id);
    const before = await request('GET', `/applications/${appId}/roles/me`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ applicationId: appId, userId: outsider.id, permissions: [] });

    actAs(admin.id);
    const granted = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: outsider.id,
      permission: 'payments.operate',
      reason: 'On call this week',
    });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({
      applicationId: appId,
      permission: 'payments.operate',
      userId: outsider.id,
      username: outsider.username,
      grantedByUserId: admin.id,
      grantReason: 'On call this week',
      revokedAt: null,
    });

    actAs(outsider.id);
    const held = await request('GET', `/applications/${appId}/roles/me`);
    expect(held.body.permissions).toEqual(['payments.operate']);

    actAs(admin.id);
    const duplicate = await request('POST', `/applications/${appId}/roles/grants`, {
      username: outsider.username.toUpperCase(),
      permission: 'payments.operate',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('ALREADY_GRANTED');
    expect(duplicate.body.details).toEqual({ grantId: granted.body.id });

    const revoked = await request(
      'POST',
      `/applications/${appId}/roles/grants/${granted.body.id}/revoke`,
      { reason: 'Rotation ended' },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      revokedByUserId: admin.id,
      revokeReason: 'Rotation ended',
    });
    expect(
      (await request('POST', `/applications/${appId}/roles/grants/${granted.body.id}/revoke`, {}))
        .body.error,
    ).toBe('ALREADY_REVOKED');

    actAs(outsider.id);
    expect((await request('GET', `/applications/${appId}/roles/me`)).body.permissions).toEqual([]);

    // Re-granting is a NEW row; the revoked one stays as history.
    actAs(admin.id);
    const regranted = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: outsider.id,
      permission: 'payments.operate',
    });
    expect(regranted.status).toBe(201);
    expect(regranted.body.id).not.toBe(granted.body.id);
    const history = await request(
      'GET',
      `/applications/${appId}/roles/grants?includeRevoked=true&userId=${outsider.id}`,
    );
    expect(history.body.items.map((grant: { id: string }) => grant.id)).toEqual([
      regranted.body.id,
      granted.body.id,
    ]);
  });

  it('answers the HUMAN operator, not the organization they act as', async () => {
    const { org, admin, secondAdmin, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);
    await request('POST', `/applications/${appId}/roles/grants`, {
      userId: secondAdmin.id,
      permission: 'catalog.operate',
    });

    // The second admin, switched into the organization: the session speaks as
    // the org, the operator is still the person.
    actAs(secondAdmin.id, org.id);
    const me = await request('GET', `/applications/${appId}/roles/me`);
    expect(me.body).toEqual({
      applicationId: appId,
      userId: secondAdmin.id,
      permissions: ['catalog.operate'],
    });

    // And the grant made while acting as the org names the person.
    const grant = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: admin.id,
      permission: 'guest.operate',
    });
    expect(grant.status).toBe(201);
    expect(grant.body.grantedByUserId).toBe(secondAdmin.id);
  });

  it('refuses a self-grant on an organization app, admits it on your own personal app', async () => {
    const { admin, secondAdmin, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);

    const self = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: admin.id,
      permission: 'payments.operate',
    });
    expect(self.status).toBe(403);
    expect(self.body.error).toBe('SELF_GRANT_FORBIDDEN');

    // Control: the same admin, the same key, another person — admitted.
    const other = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: secondAdmin.id,
      permission: 'payments.operate',
    });
    expect(other.status).toBe(201);

    // A solo developer's own app: nobody else could ever grant it.
    const solo = await seedAccount();
    const soloApp = await seedApp(solo.id);
    actAs(solo.id);
    await declare(soloApp, [{ key: 'admin.operate', description: 'Everything' }]);
    const soloGrant = await request('POST', `/applications/${soloApp}/roles/grants`, {
      userId: solo.id,
      permission: 'admin.operate',
    });
    expect(soloGrant.status).toBe(201);
  });

  it('refuses an undeclared key and a grantee who is not a person', async () => {
    const { org, admin, outsider, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);

    const unknown = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: outsider.id,
      permission: 'refunds.operate',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toBe('UNKNOWN_PERMISSION');

    const toOrg = await request('POST', `/applications/${appId}/roles/grants`, {
      userId: org.id,
      permission: 'payments.operate',
    });
    expect(toOrg.status).toBe(422);
    expect(toOrg.body.error).toBe('GRANTEE_NOT_A_PERSON');

    const missing = await request('POST', `/applications/${appId}/roles/grants`, {
      username: `nobody-${crypto.randomBytes(4).toString('hex')}`,
      permission: 'payments.operate',
    });
    expect(missing.status).toBe(404);
  });

  it('retiring a key revokes its grants in the same write and they never come back', async () => {
    const { admin, outsider, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);
    await request('POST', `/applications/${appId}/roles/grants`, {
      userId: outsider.id,
      permission: 'payments.operate',
    });
    await request('POST', `/applications/${appId}/roles/grants`, {
      userId: outsider.id,
      permission: 'catalog.operate',
    });

    const retired = await declare(appId, MERCARIA_VOCABULARY.slice(1));
    expect(retired.body).toMatchObject({ retired: ['payments.operate'], revokedGrants: 1 });

    actAs(outsider.id);
    expect((await request('GET', `/applications/${appId}/roles/me`)).body.permissions).toEqual([
      'catalog.operate',
    ]);

    // Declaring the key again starts it with nobody holding it.
    actAs(admin.id);
    const redeclared = await declare(appId);
    expect(redeclared.body.added).toEqual(['payments.operate']);
    actAs(outsider.id);
    expect((await request('GET', `/applications/${appId}/roles/me`)).body.permissions).toEqual([
      'catalog.operate',
    ]);

    actAs(admin.id);
    const withRetired = await request(
      'GET',
      `/applications/${appId}/roles/permissions?includeRetired=true`,
    );
    expect(
      withRetired.body.items.filter((item: { key: string }) => item.key === 'payments.operate'),
    ).toHaveLength(2);
  });
});

describe('roles/me', () => {
  it('is scoped: a session bound to another application may not ask', async () => {
    const { admin, outsider, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);
    const otherApp = await seedApp(admin.id);

    actAs(outsider.id);
    currentBoundApplicationId = otherApp;
    const mismatch = await request('GET', `/applications/${appId}/roles/me`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe('SESSION_APPLICATION_MISMATCH');

    // Controls: the app's own session, and the shared first-party session.
    currentBoundApplicationId = appId;
    expect((await request('GET', `/applications/${appId}/roles/me`)).status).toBe(200);
    currentBoundApplicationId = null;
    expect((await request('GET', `/applications/${appId}/roles/me`)).status).toBe(200);
  });

  it('answers 404 for a deleted or unknown application and keys of OTHER apps never leak', async () => {
    const first = await seedOrg();
    const second = await seedOrg();
    actAs(first.admin.id);
    await declare(first.appId);
    await request('POST', `/applications/${first.appId}/roles/grants`, {
      userId: first.outsider.id,
      permission: 'payments.operate',
    });

    actAs(first.outsider.id);
    const elsewhere = await request('GET', `/applications/${second.appId}/roles/me`);
    expect(elsewhere.body.permissions).toEqual([]);

    await getDb()
      .update(applications)
      .set({ status: 'deleted' })
      .where(eq(applications.id, first.appId));
    expect((await request('GET', `/applications/${first.appId}/roles/me`)).status).toBe(404);
    expect((await request('GET', '/applications/does-not-exist/roles/me')).status).toBe(404);
  });
});

describe('the grant list', () => {
  it('pages with a cursor bound to its filters', async () => {
    const { admin, appId } = await seedOrg();
    actAs(admin.id);
    await declare(appId);
    const grantees = await Promise.all([seedAccount(), seedAccount(), seedAccount()]);
    for (const grantee of grantees) {
      await request('POST', `/applications/${appId}/roles/grants`, {
        userId: grantee.id,
        permission: 'guest.operate',
      });
    }

    const first = await request('GET', `/applications/${appId}/roles/grants?limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(
      'GET',
      `/applications/${appId}/roles/grants?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map(
      (grant: { id: string }) => grant.id,
    );
    expect(new Set(ids).size).toBe(3);

    const replayed = await request(
      'GET',
      `/applications/${appId}/roles/grants?limit=2&permission=guest.operate&cursor=${first.body.nextCursor}`,
    );
    expect(replayed.status).toBe(400);

    // The rows are this test's own: scoped by application, so a sibling file
    // seeding grants cannot move the count.
    const stored = await getDb()
      .select({ id: applicationRoleGrants.id })
      .from(applicationRoleGrants)
      .innerJoin(
        applicationRolePermissions,
        eq(applicationRolePermissions.id, applicationRoleGrants.permissionId),
      )
      .where(eq(applicationRolePermissions.applicationId, appId));
    expect(stored).toHaveLength(3);
  });
});
