/**
 * PATCH /accounts/:id/members/:memberId — per-member permission editing and the
 * guards that stop it becoming a privilege-escalation endpoint.
 *
 * The real router over real Postgres with the real `account.service`: the guards
 * are distributed across `loadAccountContext` → `requireAccountPermission` →
 * the route body → `accountService.updateMember`, so mocking the service would
 * leave most of the thing under test unexecuted. Only auth, the rate limiter,
 * the logger and the session/device collaborators (which this route never
 * touches, but the router imports) are stubbed.
 *
 * ## Why the ACTOR in most cases is an admin and not an owner
 *
 * `members:update` is held by owner and admin, and admin's baseline is a proper
 * subset of owner's. A suite whose actor is always an owner cannot tell "an
 * actor may grant what they hold" from "anyone may grant anything" — every
 * request would be permitted under both rules. Each refusal below therefore has
 * a matching PERMITTED case that differs only in who is asking or what is being
 * asked for, so a blanket-deny implementation fails just as loudly as a
 * blanket-allow one.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

let actingUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: actingUserId, id: actingUserId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({ isStaffUser: () => false }));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getSession: jest.fn() },
}));

jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { addAccount: jest.fn() },
}));

jest.mock('../../utils/socket', () => ({ broadcastDeviceState: jest.fn() }));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import accountsRouter from '../accounts';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import { permissionsForAccountRole, type AccountRole } from '../../utils/accountRoles';

interface MemberBody {
  permissions?: string[];
  permissionGrants?: string[];
  permissionRevokes?: string[];
  role?: string;
  inherit?: boolean;
}

interface JsonResponse {
  status: number;
  body: { message?: string; member?: MemberBody };
}

let server: http.Server;

function uniqueUsername(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function seedUser(kind: 'personal' | 'organization' | 'project'): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', username: uniqueUsername(kind), kind })
    .returning({ id: users.id });
  return row.id;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
  extra: { permissionGrants?: string[]; permissionRevokes?: string[] } = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(accountMembers)
    .values({
      accountId,
      memberUserId,
      role,
      inherit: true,
      status: 'active',
      permissionGrants: extra.permissionGrants ?? [],
      permissionRevokes: extra.permissionRevokes ?? [],
    })
    .returning({ id: accountMembers.id });
  return row.id;
}

function patchMember(
  accountId: string,
  memberId: string,
  payload: Record<string, unknown>
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/accounts/${accountId}/members/${memberId}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer user-token',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as JsonResponse['body']) : {},
          });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function inviteMember(
  accountId: string,
  payload: Record<string, unknown>
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/accounts/${accountId}/members`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer user-token',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as JsonResponse['body']) : {},
          });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function rowById(memberId: string) {
  const [row] = await getDb()
    .select()
    .from(accountMembers)
    .where(eq(accountMembers.id, memberId));
  return row;
}

/**
 * One organization with an owner, an admin (the usual actor) and a viewer (the
 * usual target). Returns everything by id so a case can pick who asks.
 */
async function seedOrg() {
  const org = await seedUser('organization');
  const ownerUserId = await seedUser('personal');
  const adminUserId = await seedUser('personal');
  const targetUserId = await seedUser('personal');

  const ownerMemberId = await seedMember(org, ownerUserId, 'owner');
  const adminMemberId = await seedMember(org, adminUserId, 'admin');
  const targetMemberId = await seedMember(org, targetUserId, 'viewer');

  return { org, ownerUserId, adminUserId, targetUserId, ownerMemberId, adminMemberId, targetMemberId };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('per-member permission editing', () => {
  test('an admin may grant a permission the admin holds', async () => {
    const { org, adminUserId, targetMemberId } = await seedOrg();
    // Non-vacuity: the grant has to be something the TARGET does not already
    // have, or a no-op write would pass this case.
    expect(permissionsForAccountRole('viewer')).not.toContain('credentials:read');
    expect(permissionsForAccountRole('admin')).toContain('credentials:read');
    actingUserId = adminUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['credentials:read'],
    });

    expect(res.status).toBe(200);
    expect(res.body.member?.permissionGrants).toEqual(['credentials:read']);
    // The serialized `permissions` is the EFFECTIVE set, which is what every
    // consumer gates on.
    expect(res.body.member?.permissions).toContain('credentials:read');
    expect((await rowById(targetMemberId)).permissionGrants).toEqual(['credentials:read']);
  });

  test('an admin may NOT grant a permission the admin does not hold', async () => {
    const { org, adminUserId, targetMemberId } = await seedOrg();
    // The whole case rests on this being absent from the admin baseline.
    expect(permissionsForAccountRole('admin')).not.toContain('ownership:transfer');
    actingUserId = adminUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['ownership:transfer'],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot grant permissions you do not hold/i);
    // A refusal that still wrote would be the worst possible outcome here.
    expect((await rowById(targetMemberId)).permissionGrants).toEqual([]);
  });

  test('an OWNER may grant that same permission — the refusal is about the actor', async () => {
    // The control for the case above. Without it, a blanket "nobody may grant
    // ownership:transfer" would be indistinguishable from the actual rule.
    const { org, ownerUserId, targetMemberId } = await seedOrg();
    expect(permissionsForAccountRole('owner')).toContain('ownership:transfer');
    actingUserId = ownerUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['ownership:transfer'],
    });

    expect(res.status).toBe(200);
    expect((await rowById(targetMemberId)).permissionGrants).toEqual(['ownership:transfer']);
  });

  test('the bound is the actor EFFECTIVE set, not their role baseline', async () => {
    // An admin whose own `credentials:create` was revoked cannot re-mint it
    // through somebody else's row. A guard written against
    // `permissionsForAccountRole(access.role)` would permit this.
    const { org, adminUserId, adminMemberId, targetMemberId } = await seedOrg();
    expect(permissionsForAccountRole('admin')).toContain('credentials:create');
    await getDb()
      .update(accountMembers)
      .set({ permissionRevokes: ['credentials:create'] })
      .where(eq(accountMembers.id, adminMemberId));
    actingUserId = adminUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['credentials:create'],
    });

    expect(res.status).toBe(403);
    expect((await rowById(targetMemberId)).permissionGrants).toEqual([]);
  });

  test('a role change may not restore a permission revoked from the actor', async () => {
    const { org, adminUserId, adminMemberId, targetMemberId } = await seedOrg();
    await getDb()
      .update(accountMembers)
      .set({ permissionRevokes: ['credentials:create'] })
      .where(eq(accountMembers.id, adminMemberId));
    actingUserId = adminUserId;

    const res = await patchMember(org, targetMemberId, { role: 'developer' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('credentials:create');
    expect((await rowById(targetMemberId)).role).toBe('viewer');
  });

  test('an invite may not restore a permission revoked from the actor', async () => {
    const { org, adminUserId, adminMemberId } = await seedOrg();
    const invitee = uniqueUsername('invitee');
    await getDb().insert(users).values({ color: 'teal', username: invitee, kind: 'personal' });
    await getDb()
      .update(accountMembers)
      .set({ permissionRevokes: ['account:act_as'] })
      .where(eq(accountMembers.id, adminMemberId));
    actingUserId = adminUserId;

    const res = await inviteMember(org, { usernameOrEmail: invitee, role: 'editor' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('account:act_as');
  });

  test('a grant BEYOND the actor is refused even when bundled with a legal one', async () => {
    // Partial application would be the subtle failure: the legal half landing
    // while the response says 403.
    const { org, adminUserId, targetMemberId } = await seedOrg();
    actingUserId = adminUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['credentials:read', 'ownership:transfer'],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('ownership:transfer');
    expect((await rowById(targetMemberId)).permissionGrants).toEqual([]);
  });

  test('an actor may REVOKE a permission they do not themselves hold', async () => {
    // Revokes are deliberately outside rule 1: taking something away is not a
    // conferral, and a grant left by a departed owner must remain withdrawable.
    const { org, adminUserId } = await seedOrg();
    const richMemberId = await seedMember(org, await seedUser('personal'), 'editor', {
      permissionGrants: ['ownership:transfer'],
    });
    expect(permissionsForAccountRole('admin')).not.toContain('ownership:transfer');
    actingUserId = adminUserId;

    const res = await patchMember(org, richMemberId, {
      permissionRevokes: ['ownership:transfer'],
    });

    expect(res.status).toBe(200);
    expect(res.body.member?.permissions).not.toContain('ownership:transfer');
  });

  test('an actor may not edit their OWN membership row', async () => {
    const { org, adminUserId, adminMemberId } = await seedOrg();
    actingUserId = adminUserId;

    const res = await patchMember(org, adminMemberId, { permissionRevokes: ['members:invite'] });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own membership/i);
    expect((await rowById(adminMemberId)).permissionRevokes).toEqual([]);
  });

  test("an OWNER row's permissions cannot be edited by anyone", async () => {
    // Asked by another owner-equivalent authority (the second owner below), so
    // the refusal is about the TARGET being an owner rather than about the actor
    // lacking `members:update`.
    const { org, ownerMemberId } = await seedOrg();
    const secondOwnerUserId = await seedUser('personal');
    await seedMember(org, secondOwnerUserId, 'owner');
    actingUserId = secondOwnerUserId;

    const res = await patchMember(org, ownerMemberId, {
      permissionRevokes: ['account:delete'],
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/transfer-ownership/i);
    expect((await rowById(ownerMemberId)).permissionRevokes).toEqual([]);
  });

  test('an unknown permission string is a 400, not a stored value', async () => {
    const { org, ownerUserId, targetMemberId } = await seedOrg();
    actingUserId = ownerUserId;

    const res = await patchMember(org, targetMemberId, {
      permissionGrants: ['account:moderate'],
    });

    expect(res.status).toBe(400);
    expect((await rowById(targetMemberId)).permissionGrants).toEqual([]);
  });

  test('an empty body is a 400', async () => {
    const { org, ownerUserId, targetMemberId } = await seedOrg();
    actingUserId = ownerUserId;

    expect((await patchMember(org, targetMemberId, {})).status).toBe(400);
  });

  test('an empty array CLEARS a delta list', async () => {
    const { org, ownerUserId, targetMemberId } = await seedOrg();
    await getDb()
      .update(accountMembers)
      .set({ permissionGrants: ['credentials:read'] })
      .where(eq(accountMembers.id, targetMemberId));
    actingUserId = ownerUserId;

    const res = await patchMember(org, targetMemberId, { permissionGrants: [] });

    expect(res.status).toBe(200);
    expect((await rowById(targetMemberId)).permissionGrants).toEqual([]);
  });

  test('a role-only patch still works and leaves the deltas alone', async () => {
    const { org, ownerUserId, targetMemberId } = await seedOrg();
    await getDb()
      .update(accountMembers)
      .set({ permissionGrants: ['credentials:read'] })
      .where(eq(accountMembers.id, targetMemberId));
    actingUserId = ownerUserId;

    const res = await patchMember(org, targetMemberId, { role: 'developer' });

    expect(res.status).toBe(200);
    expect(res.body.member?.role).toBe('developer');
    // Absent means UNCHANGED — only `[]` clears.
    expect((await rowById(targetMemberId)).permissionGrants).toEqual(['credentials:read']);
  });

  test('a member of ANOTHER account is a 404, not an edit', async () => {
    const first = await seedOrg();
    const second = await seedOrg();
    actingUserId = first.ownerUserId;

    const res = await patchMember(first.org, second.targetMemberId, {
      permissionGrants: ['credentials:read'],
    });

    expect(res.status).toBe(404);
    expect((await rowById(second.targetMemberId)).permissionGrants).toEqual([]);
  });

  test('an actor without members:update cannot reach the editor at all', async () => {
    // `viewer` holds `members:read` but not `members:update`, so the RBAC
    // middleware refuses before any of the rules above are consulted.
    const { org, targetUserId, ownerMemberId } = await seedOrg();
    expect(permissionsForAccountRole('viewer')).not.toContain('members:update');
    actingUserId = targetUserId;

    const res = await patchMember(org, ownerMemberId, { role: 'developer' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/members:update/);
  });

  test('a member with a GRANTED members:update can reach the editor', async () => {
    // The control for the case above, and the end-to-end proof that a per-member
    // grant is honoured by `requireAccountPermission` and not only by the
    // serializer: `developer` has no `members:read` either, so this member is
    // reaching a route their role cannot.
    const { org, targetMemberId, targetUserId } = await seedOrg();
    const victimMemberId = await seedMember(org, await seedUser('personal'), 'viewer');
    await getDb()
      .update(accountMembers)
      .set({ role: 'developer', permissionGrants: ['members:update'] })
      .where(eq(accountMembers.id, targetMemberId));
    expect(permissionsForAccountRole('developer')).not.toContain('members:update');
    actingUserId = targetUserId;

    const res = await patchMember(org, victimMemberId, { role: 'developer' });

    expect(res.status).toBe(200);
    expect(res.body.member?.role).toBe('developer');
  });

  test('an INHERITED actor is bound by the same rules as a direct one', async () => {
    // Access resolved from an ancestor row carries that row's deltas, so an
    // admin narrowed at the org level cannot widen someone on the project.
    const org = await seedUser('organization');
    const project = await seedUser('project');
    await getDb()
      .update(users)
      .set({ parentAccountId: org, rootAccountId: org })
      .where(eq(users.id, project));
    // `depth = 0` is the tree root and the highest depth is the immediate
    // parent, so a direct child of a root carries exactly one edge at 0.
    await getDb()
      .insert(userAncestors)
      .values({ userId: project, ancestorId: org, depth: 0 });

    const adminUserId = await seedUser('personal');
    await seedMember(org, adminUserId, 'admin', {
      permissionRevokes: ['credentials:create'],
    });
    const victimMemberId = await seedMember(project, await seedUser('personal'), 'viewer');
    actingUserId = adminUserId;

    const refused = await patchMember(project, victimMemberId, {
      permissionGrants: ['credentials:create'],
    });
    expect(refused.status).toBe(403);

    // …and is still able to grant what it does hold, so the case is not just
    // "an inherited actor can do nothing".
    const allowed = await patchMember(project, victimMemberId, {
      permissionGrants: ['credentials:read'],
    });
    expect(allowed.status).toBe(200);
  });
});

describe('a member of another account entirely', () => {
  test('is refused with no access to the account', async () => {
    const { org, targetMemberId } = await seedOrg();
    const outsider = await seedUser('personal');
    actingUserId = outsider;

    const res = await patchMember(org, targetMemberId, { role: 'developer' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not have access/i);
    expect((await rowById(targetMemberId)).role).toBe('viewer');
  });
});
