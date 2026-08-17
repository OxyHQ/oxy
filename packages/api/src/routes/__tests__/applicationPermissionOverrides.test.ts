/**
 * A per-member permission override reaches the APPLICATION lane (issue #978).
 *
 * The account lane and the application lane gate the same powers through two
 * vocabularies — `credentials:rotate` is spelled the same in both, `app:update`
 * is `apps:update` on the account side — and only one of them used to resolve
 * the membership row's `permission_grants` / `permission_revokes`. An
 * administrator who revoked `credentials:rotate` from a member was refused on
 * `/accounts/*` and permitted on `/applications/*`.
 *
 * ## Why the real service and a real row
 *
 * The whole point of the defect is that a stored delta failed to travel from
 * `account_members` to the application RBAC middleware. A mocked
 * `account.service` supplies the far end of that journey by hand, so it can
 * only ever test the last hop. Everything here is real — the membership row,
 * `accountService.resolveEffectiveAccess`, the router, Postgres — and only the
 * auth middleware (caller identity) and the CORS-registry refresh (a background
 * Mongo-free snapshot this route fires and forgets) are stubbed.
 *
 * ## Every refusal has a control that differs by ONE fixture field
 *
 * A route that 403s because its fixture never reached it looks exactly like a
 * route that 403s because the gate fired. So each case below is a PAIR: the
 * same seeded app, the same role, the same request — one member carrying the
 * delta and one without it. The control failing is what tells you the fixture
 * is capable of reaching the route at all.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: currentUserId, id: currentUserId };
    next();
  },
}));

/**
 * Non-staff by default, flippable for the one case that needs a staff control.
 * A plain `() => false` could not express "staff MAY do this", which is half of
 * what makes a staff gate a gate.
 */
const mockIsStaffUser = jest.fn(() => false);
jest.mock('../../middleware/requireStaff', () => ({
  isStaffUser: () => mockIsStaffUser(),
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
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials, applications, users } from '../../db/schema';
import applicationsRouter from '../applications';
import { errorHandler } from '../../middleware/errorHandler';
import type { AccountPermission, AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';
import type { ApplicationScope } from '../../utils/applicationScopes';

let server: http.Server;
let currentUserId = '';

interface JsonResponse {
  status: number;
  body: {
    application?: { callerMembership?: { role?: string; permissions?: string[] } };
    applications?: Array<{
      _id?: string;
      callerMembership?: { role?: string; permissions?: string[] };
    }>;
    credential?: Record<string, unknown>;
    credentials?: Array<Record<string, unknown>>;
    secret?: string | null;
    message?: string;
  };
}

function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
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

/** A real `users` row — every account in this graph is one. */
async function seedAccount(kind: 'personal' | 'organization' = 'personal'): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `perm-${crypto.randomBytes(6).toString('hex')}`, kind })
    .returning({ id: users.id });
  return row.id;
}

/** A real `account_members` row, deltas included. */
async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
  deltas: { grants?: AccountPermission[]; revokes?: AccountPermission[] } = {}
): Promise<void> {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId,
    role,
    inherit: true,
    status: 'active',
    permissionGrants: deltas.grants ?? [],
    permissionRevokes: deltas.revokes ?? [],
  });
}

async function seedApp(
  ownerAccountId: string,
  scopes: ApplicationScope[] = []
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Override App', ownerAccountId, createdByUserId: ownerAccountId, scopes })
    .returning({ id: applications.id });
  return row.id;
}

async function seedCredential(applicationId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'Cred',
      publicKey: `oxy_dk_${crypto.randomBytes(12).toString('hex')}`,
      secretHash: 'hash',
      type: 'confidential',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return row.id;
}

/**
 * One organization owning one application, with two members of the SAME role:
 * `subject` carries the delta under test, `control` carries none.
 */
async function seedOrgWithApp(
  role: AccountRole,
  deltas: { grants?: AccountPermission[]; revokes?: AccountPermission[] }
) {
  const org = await seedAccount('organization');
  const subject = await seedAccount();
  const control = await seedAccount();
  await seedMember(org, subject, role, deltas);
  await seedMember(org, control, role);
  const appId = await seedApp(org);
  return { org, subject, control, appId };
}

beforeEach(() => {
  mockIsStaffUser.mockReturnValue(false);
});

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

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('a per-member REVOKE is honoured by the application RBAC lane', () => {
  test('credentials:rotate — refused for the member it was revoked from, allowed for their twin', async () => {
    // Non-vacuity: the role under test must actually carry the power, or the
    // refusal below would be the role's doing and the revoke untested.
    expect(permissionsForAccountRole('admin')).toContain('credentials:rotate');

    const { subject, control, appId } = await seedOrgWithApp('admin', {
      revokes: ['credentials:rotate'],
    });
    const credentialId = await seedCredential(appId);

    currentUserId = subject;
    const revoked = await request('POST', `/applications/${appId}/credentials/${credentialId}/rotate`);
    expect(revoked.status).toBe(403);
    expect(revoked.body.message).toContain('credentials:rotate');

    // Control: the same request, from a member of the same role WITHOUT the
    // revoke. A fixture that could not reach the route would fail here.
    currentUserId = control;
    const permitted = await request(
      'POST',
      `/applications/${appId}/credentials/${credentialId}/rotate`
    );
    expect(permitted.status).toBe(200);
    expect(typeof permitted.body.secret).toBe('string');

    // And the revoked member's request changed nothing: the credential the
    // control rotated is the only rotation that happened.
    const rows = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, appId));
    expect(rows).toHaveLength(2);
  });

  test('apps:update — the account-side spelling of app:update reaches the app lane', async () => {
    expect(permissionsForAccountRole('admin')).toContain('apps:update');

    const { subject, control, appId } = await seedOrgWithApp('admin', {
      revokes: ['apps:update'],
    });

    currentUserId = subject;
    const revoked = await request('PATCH', `/applications/${appId}`, { name: 'Renamed by revoked' });
    expect(revoked.status).toBe(403);

    currentUserId = control;
    const permitted = await request('PATCH', `/applications/${appId}`, { name: 'Renamed by control' });
    expect(permitted.status).toBe(200);

    const [stored] = await getDb()
      .select({ name: applications.name })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(stored.name).toBe('Renamed by control');
  });

  test('credentials:read — the revoke also disappears from the serialized callerMembership', async () => {
    const { subject, control, appId } = await seedOrgWithApp('admin', {
      revokes: ['credentials:read'],
    });

    currentUserId = subject;
    const listed = await request('GET', `/applications/${appId}/credentials`);
    expect(listed.status).toBe(403);

    // The projection the Console reads to decide what to render must agree with
    // the gate; otherwise the UI offers an action the API refuses.
    const detail = await request('GET', `/applications/${appId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.application?.callerMembership?.permissions).not.toContain('credentials:read');

    const list = await request('GET', '/applications');
    expect(list.status).toBe(200);
    // The list serialises the id as `_id`. Asserted present before it is read,
    // so a projection that stopped returning the app cannot pass this case by
    // leaving the permission assertion with nothing to look at.
    const entry = list.body.applications?.find((row) => row._id === appId);
    expect(entry).toBeDefined();
    expect(entry?.callerMembership?.permissions).not.toContain('credentials:read');

    currentUserId = control;
    const controlListed = await request('GET', `/applications/${appId}/credentials`);
    expect(controlListed.status).toBe(200);
    const controlDetail = await request('GET', `/applications/${appId}`);
    expect(controlDetail.body.application?.callerMembership?.permissions).toContain(
      'credentials:read'
    );
  });
});

describe('a per-member GRANT is honoured by the application RBAC lane', () => {
  test('credentials:read granted to a viewer opens the app lane it opens on the account lane', async () => {
    // Non-vacuity: the role must NOT already carry it, or the permitted case
    // below would pass without the grant doing anything.
    expect(permissionsForAccountRole('viewer')).not.toContain('credentials:read');

    const { subject, control, appId } = await seedOrgWithApp('viewer', {
      grants: ['credentials:read'],
    });

    currentUserId = subject;
    const granted = await request('GET', `/applications/${appId}/credentials`);
    expect(granted.status).toBe(200);

    currentUserId = control;
    const ungranted = await request('GET', `/applications/${appId}/credentials`);
    expect(ungranted.status).toBe(403);
  });
});

/**
 * A privileged scope is staff-gated on the CREDENTIAL-create path too
 * (issue #972 §3).
 *
 * `authorizeRequestedScopes` makes adding a privileged scope to an APPLICATION
 * staff-only, and `accounts.ts` has always filtered them on account-credential
 * create. `applications.ts` did not, so a member holding `credentials:create` —
 * the `developer` role does, and it carries no `account:update` — could put a
 * scope staff had granted the application onto a new long-lived credential of
 * their own and act with it.
 */
describe('a privileged scope may not be self-granted onto a new credential', () => {
  const PRIVILEGED: ApplicationScope = 'inference:providers:write';
  const ORDINARY: ApplicationScope = 'files:read';

  async function seedDeveloperOnScopedApp() {
    const org = await seedAccount('organization');
    const developer = await seedAccount();
    await seedMember(org, developer, 'developer');
    // The application legitimately HOLDS the privileged scope — staff granted it
    // for the application's own use. Without this the subset check at
    // `applications.ts` would refuse first and the filter would go untested.
    const appId = await seedApp(org, [ORDINARY, PRIVILEGED]);
    return { org, developer, appId };
  }

  function createCredential(appId: string, scopes: ApplicationScope[]) {
    return request('POST', `/applications/${appId}/credentials`, {
      name: 'Minted',
      type: 'confidential',
      environment: 'production',
      scopes,
    });
  }

  test('refused for a non-staff member, permitted for staff, same member and body', async () => {
    // Non-vacuity: the role must be able to create credentials at all, and must
    // not already hold the BYOK write — otherwise the refusal is the RBAC gate.
    expect(permissionsForAccountRole('developer')).toContain('credentials:create');
    expect(permissionsForAccountRole('developer')).not.toContain('inference:providers:write');

    const { developer, appId } = await seedDeveloperOnScopedApp();
    currentUserId = developer;

    const refused = await createCredential(appId, [PRIVILEGED]);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain(PRIVILEGED);
    expect(refused.body.message).toContain('staff');

    // CONTROL: the same request carrying only a self-grantable scope succeeds, so
    // the 403 is the filter and not a fixture that cannot reach the route.
    const ordinary = await createCredential(appId, [ORDINARY]);
    expect(ordinary.status).toBe(201);

    // CONTROL: staff may. Identical member, identical body to the refusal.
    mockIsStaffUser.mockReturnValue(true);
    const staffMinted = await createCredential(appId, [PRIVILEGED]);
    expect(staffMinted.status).toBe(201);

    // Exactly one credential carries it, and it is the staff-minted one.
    const rows = await getDb()
      .select({ scopes: applicationCredentials.scopes })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, appId));
    expect(rows.filter((row) => row.scopes.includes(PRIVILEGED))).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  test('a mixed request is refused whole, naming only the privileged scope', async () => {
    const { developer, appId } = await seedDeveloperOnScopedApp();
    currentUserId = developer;

    const refused = await createCredential(appId, [ORDINARY, PRIVILEGED]);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain(PRIVILEGED);
    expect(refused.body.message).not.toContain(ORDINARY);

    // Nothing was minted with the self-grantable half either — a partial mint
    // would be a credential the caller did not ask for.
    const rows = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, appId));
    expect(rows).toHaveLength(0);
  });
});
