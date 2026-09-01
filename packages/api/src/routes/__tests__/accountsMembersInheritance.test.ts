/**
 * GET /accounts/:id/members — the roster, and the inherited members it used to
 * leave out.
 *
 * ## What broke, and why a one-sided suite cannot see it
 *
 * `resolveEffectiveAccess` has always honoured inheritance: an ancestor row with
 * `inherit: true` confers every account permission on the descendant,
 * `account:act_as` included. The roster was built from direct rows alone, so it
 * answered `[]` for an account somebody could act on — and answered it TO that
 * person, who had just been let through `members:read` by the very row the list
 * omitted. Consumers that look themselves up in this list to decide whether they
 * may act (Mention's publish-as gate) therefore read "not a member" for somebody
 * `POST /accounts/:id/switch` would let in.
 *
 * FOUR actors, because fewer cannot tell the rules apart. A suite with only a
 * direct member and a stranger passes identically whether inheritance counts or
 * not. A suite with only a direct and an inherited member passes identically
 * whether inheritance counts or EVERY reachable person counts. So:
 *
 *  - `directUser`   — a row on the child. Must stay, must stay editable.
 *  - `inheritedUser`— an `inherit: true` row on the parent. Must appear, marked
 *                     `inherited`, carrying the ancestor's row id and account id.
 *  - `blockedUser`  — an `inherit: false` row on the parent. Must NOT appear, and
 *                     must be refused the endpoint entirely. This is the fixture
 *                     that separates "inherited membership counts" from "anybody
 *                     with a row anywhere up the tree counts"; without it, an
 *                     implementation that ignored `inherit` passes every case.
 *  - `strangerUser` — no row anywhere. Must be refused.
 *
 * The real router over real Postgres with the real `account.service`, for the
 * same reason `accountsMemberPermissions.test.ts` gives: the behaviour is spread
 * across `loadAccountContext` → `requireAccountPermission` → the route body →
 * the service, and mocking the service would leave most of it unexecuted.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';

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
import { accountService } from '../../services/account.service';
import { permissionsForAccountRole, type AccountRole } from '../../utils/accountRoles';

/** The member shape this endpoint serialises, as far as these cases read it. */
interface MemberBody {
  _id: string;
  accountId: string;
  memberUserId: string;
  role: AccountRole;
  permissions: string[];
  inherit: boolean;
  status: string;
  source: 'direct' | 'inherited';
}

interface ListResponse {
  status: number;
  body: { members?: MemberBody[]; message?: string };
}

let server: http.Server;

function uniqueUsername(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function seedAccount(
  kind: 'personal' | 'organization' | 'project' | 'channel',
  parentAccountId?: string
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: uniqueUsername(kind),
      kind,
      parentAccountId,
      rootAccountId: parentAccountId,
    })
    .returning({ id: users.id });
  if (parentAccountId) {
    await getDb()
      .insert(userAncestors)
      .values({ userId: row.id, ancestorId: parentAccountId, depth: 0 });
  }
  return row.id;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
  extra: {
    inherit?: boolean;
    status?: 'active' | 'invited' | 'removed';
    permissionGrants?: string[];
    permissionRevokes?: string[];
  } = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(accountMembers)
    .values({
      accountId,
      memberUserId,
      role,
      inherit: extra.inherit ?? true,
      status: extra.status ?? 'active',
      permissionGrants: extra.permissionGrants ?? [],
      permissionRevokes: extra.permissionRevokes ?? [],
    })
    .returning({ id: accountMembers.id });
  return row.id;
}

function listMembers(accountId: string): Promise<ListResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/accounts/${accountId}/members`,
        method: 'GET',
        headers: { Authorization: 'Bearer user-token' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as ListResponse['body']) : {},
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function entryFor(body: ListResponse['body'], memberUserId: string): MemberBody[] {
  return (body.members ?? []).filter((member) => member.memberUserId === memberUserId);
}

/**
 * A parent organization with a child project under it, and the four actors the
 * header describes. Returns everything by id so a case can pick who asks.
 */
async function seedTree() {
  const parent = await seedAccount('organization');
  const child = await seedAccount('project', parent);

  const directUser = await seedAccount('personal');
  const inheritedUser = await seedAccount('personal');
  const blockedUser = await seedAccount('personal');
  const strangerUser = await seedAccount('personal');

  const directRowId = await seedMember(child, directUser, 'editor');
  const inheritedRowId = await seedMember(parent, inheritedUser, 'editor', { inherit: true });
  const blockedRowId = await seedMember(parent, blockedUser, 'editor', { inherit: false });

  return {
    parent,
    child,
    directUser,
    inheritedUser,
    blockedUser,
    strangerUser,
    directRowId,
    inheritedRowId,
    blockedRowId,
  };
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

describe('the roster and the gate answer the same question', () => {
  test('an INHERITED member appears in the list they are authorised to read', async () => {
    const { child, parent, inheritedUser, inheritedRowId } = await seedTree();

    // The premise, measured rather than assumed: the gate that admits this
    // caller resolves from the ancestor row. Without this the case could pass
    // for the wrong reason (e.g. the endpoint stopped gating at all).
    const access = await accountService.resolveEffectiveAccess(inheritedUser, child);
    expect(access?.source).toBe('inherited');
    expect(access?.permissions).toContain('members:read');

    actingUserId = inheritedUser;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const own = entryFor(res.body, inheritedUser);
    expect(own).toHaveLength(1);
    expect(own[0].source).toBe('inherited');
    // The row lives on the PARENT, and the entry says so — a client that
    // addressed this `_id` through the child would get a 404 from
    // `requireDirectMember`, which is what `source` exists to prevent.
    expect(own[0].accountId).toBe(parent);
    expect(own[0]._id).toBe(inheritedRowId);
    expect(own[0].status).toBe('active');
  });

  test("an inherited entry carries the ancestor row's EFFECTIVE permissions, deltas included", async () => {
    const parent = await seedAccount('organization');
    const child = await seedAccount('project', parent);
    const holder = await seedAccount('personal');
    // `admin` carries both of these in its baseline; the row revokes one. An
    // implementation that serialised `permissionsForAccountRole(role)` instead
    // of the row's effective set passes every other case in this file and fails
    // only here.
    expect(permissionsForAccountRole('admin')).toContain('account:act_as');
    expect(permissionsForAccountRole('admin')).toContain('members:invite');
    await seedMember(parent, holder, 'admin', {
      inherit: true,
      permissionRevokes: ['account:act_as'],
    });

    actingUserId = holder;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const own = entryFor(res.body, holder);
    expect(own).toHaveLength(1);
    expect(own[0].permissions).not.toContain('account:act_as');
    // Narrowed, not emptied — a serializer that returned `[]` would also satisfy
    // the assertion above.
    expect(own[0].permissions).toContain('members:invite');
  });

  test('a DIRECT member is unchanged: present once, marked direct, on this account', async () => {
    const { child, directUser, directRowId } = await seedTree();

    actingUserId = directUser;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const own = entryFor(res.body, directUser);
    expect(own).toHaveLength(1);
    expect(own[0].source).toBe('direct');
    expect(own[0].accountId).toBe(child);
    expect(own[0]._id).toBe(directRowId);
  });

  test('an `inherit: false` ancestor row confers nothing: absent from the list, refused the endpoint', async () => {
    const { child, blockedUser, directUser } = await seedTree();

    // The gate refuses them outright — the list is not even reachable.
    actingUserId = blockedUser;
    expect((await listMembers(child)).status).toBe(403);

    // And nobody else sees them in it either. This is the assertion that tells
    // "inherited membership counts" apart from "any row up the tree counts".
    actingUserId = directUser;
    const res = await listMembers(child);
    expect(res.status).toBe(200);
    expect(entryFor(res.body, blockedUser)).toHaveLength(0);
    // Non-vacuity: the SAME actor does see the inherited member, so an empty
    // result cannot be what makes the line above pass.
    expect(res.body.members?.length).toBeGreaterThan(0);
  });

  test('a NON-MEMBER is refused', async () => {
    const { child, strangerUser } = await seedTree();

    actingUserId = strangerUser;
    expect((await listMembers(child)).status).toBe(403);
  });

  test('every active entry is the row the gate would resolve for that person', async () => {
    // The property that keeps the roster and `resolveEffectiveAccess` from ever
    // disagreeing about somebody, asserted over the whole list rather than one
    // fixture: for each person the roster reports as active on this account, the
    // gate resolves the same row from the same place.
    const { child, directUser, inheritedUser } = await seedTree();

    actingUserId = directUser;
    const res = await listMembers(child);
    expect(res.status).toBe(200);

    const active = (res.body.members ?? []).filter((member) => member.status === 'active');
    // Vacuity floor: this case is worthless if the list is empty or one-sided.
    expect(active.length).toBeGreaterThanOrEqual(2);
    expect(new Set(active.map((member) => member.source))).toEqual(
      new Set(['direct', 'inherited'])
    );

    for (const member of active) {
      const access = await accountService.resolveEffectiveAccess(member.memberUserId, child);
      expect(access).not.toBeNull();
      expect(access?.source).toBe(member.source);
      expect(access?.membership?.id).toBe(member._id);
      expect(access?.permissions).toEqual(member.permissions);
    }

    expect(active.map((member) => member.memberUserId).sort()).toEqual(
      [directUser, inheritedUser].sort()
    );
  });
});

describe('the roster still answers its own question', () => {
  test('a DIRECT row that is only invited is still listed — it is a pending invitation', async () => {
    const parent = await seedAccount('organization');
    const child = await seedAccount('project', parent);
    const admin = await seedAccount('personal');
    const invitee = await seedAccount('personal');
    await seedMember(child, admin, 'admin');
    await seedMember(child, invitee, 'viewer', { status: 'invited' });

    actingUserId = admin;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const entries = entryFor(res.body, invitee);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('invited');
    expect(entries[0].source).toBe('direct');
  });

  test('a pending direct invitation and live inherited access are BOTH reported', async () => {
    // The one person who legitimately produces two entries. Keying the inherited
    // half on "no ACTIVE direct row" rather than "no row at all" is what keeps
    // both facts: the console renders pending invites as
    // `members.filter(m => m.status === 'invited')` and the active list from the
    // rest, and this person belongs in each.
    const parent = await seedAccount('organization');
    const child = await seedAccount('project', parent);
    const admin = await seedAccount('personal');
    const both = await seedAccount('personal');
    await seedMember(child, admin, 'admin');
    await seedMember(child, both, 'viewer', { status: 'invited' });
    await seedMember(parent, both, 'editor', { inherit: true });

    actingUserId = admin;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const entries = entryFor(res.body, both);
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.status === 'invited' && e.source === 'direct')).toHaveLength(1);
    expect(entries.filter((e) => e.status === 'active' && e.source === 'inherited')).toHaveLength(1);
  });

  test('an ACTIVE direct row beats the inherited one — one entry, and it is the direct one', async () => {
    const parent = await seedAccount('organization');
    const child = await seedAccount('project', parent);
    const person = await seedAccount('personal');
    const childRowId = await seedMember(child, person, 'viewer');
    await seedMember(parent, person, 'admin', { inherit: true });

    actingUserId = person;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    const entries = entryFor(res.body, person);
    expect(entries).toHaveLength(1);
    expect(entries[0]._id).toBe(childRowId);
    expect(entries[0].source).toBe('direct');
    // Non-vacuity: the two rows carry different roles, so an implementation that
    // picked the ancestor's would be visible here rather than merely producing a
    // different id.
    expect(entries[0].role).toBe('viewer');
  });

  test('a REMOVED ancestor row cascades nothing', async () => {
    const parent = await seedAccount('organization');
    const child = await seedAccount('project', parent);
    const admin = await seedAccount('personal');
    const gone = await seedAccount('personal');
    await seedMember(child, admin, 'admin');
    await seedMember(parent, gone, 'editor', { inherit: true, status: 'removed' });

    actingUserId = admin;
    const res = await listMembers(child);

    expect(res.status).toBe(200);
    expect(entryFor(res.body, gone)).toHaveLength(0);
    // Vacuity floor: the list is not empty, so the absence above means something.
    expect(entryFor(res.body, admin)).toHaveLength(1);
  });

  test('a ROOT account with no ancestors is unaffected', async () => {
    const org = await seedAccount('organization');
    const admin = await seedAccount('personal');
    await seedMember(org, admin, 'admin');

    actingUserId = admin;
    const res = await listMembers(org);

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members?.[0].source).toBe('direct');
  });

  test('a CHANNEL inherits from the tree it hangs in, which is what makes it publishable', async () => {
    // The shape Mention hits: a channel can never be switched into, so membership
    // IS the whole right over it — and the member whose row lives on the parent
    // org had been invisible to the only list that answers who those members are.
    const org = await seedAccount('organization');
    const channel = await seedAccount('channel', org);
    const person = await seedAccount('personal');
    await seedMember(org, person, 'editor', { inherit: true });

    actingUserId = person;
    const res = await listMembers(channel);

    expect(res.status).toBe(200);
    const own = entryFor(res.body, person);
    expect(own).toHaveLength(1);
    expect(own[0].status).toBe('active');
    expect(own[0].source).toBe('inherited');
  });
});
