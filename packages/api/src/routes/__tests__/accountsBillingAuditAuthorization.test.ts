/**
 * `GET /accounts/:id/billing/audit` — who may read an account's funding history.
 *
 * The real router over real Postgres with the real `account.service`, because
 * the gate is spread across `loadAccountContext` → `requireAccountPermission` →
 * `effectivePermissionsForMember`, and mocking any of it would leave the thing
 * under test unexecuted. Only auth, the rate limiter, the logger and the
 * session/device collaborators the router imports are stubbed.
 *
 * ## The permission this file exists to hold at `billing:read`
 *
 * `account:read` is the obvious wrong answer and it is wrong in a way nothing
 * would report: it is baseline for EVERY account role, so gating there would
 * publish every top-up, every promotional grant and every invoice payment to a
 * `viewer` — someone the role table deliberately gives no financial visibility
 * at all. The endpoint would work perfectly and leak.
 *
 * So every case is a PAIR over the same seeded account and the same request,
 * differing only in the asking member's role, and each refusal is stated beside
 * the role-table fact that makes it a refusal rather than an accident.
 *
 * ## The vacuity floor
 *
 * A `viewer` reading `GET /accounts/:id` successfully. Without it, a 403 because
 * the gate fired and a 403 because the fixture never authenticated look
 * identical — and that failure would make this whole file green against a router
 * that refused everyone.
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
import { users } from '../../db/schema/users';
import { permissionsForAccountRole, type AccountRole } from '../../utils/accountRoles';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';

jest.setTimeout(60_000);

let server: http.Server;

interface AuditEntry {
  readonly kind: string;
  readonly amount: string;
  readonly direction: string;
  readonly actorKind: string;
}

interface JsonResponse {
  status: number;
  body: { message?: string; data?: AuditEntry[]; count?: number; nextCursor?: string | null };
}

function tag(): string {
  return randomBytes(6).toString('hex');
}

function get(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
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
            body: raw ? (JSON.parse(raw) as JsonResponse['body']) : {},
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedUser(kind: 'personal' | 'organization'): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `bau-${kind}-${tag()}`, kind })
    .returning({ id: users.id });
  return row.id;
}

/**
 * One organization holding a single $25 top-up, plus one member per role this
 * file asks about. Roles are seeded together so every case reads the SAME
 * account and the same entry, leaving the role as the only difference.
 */
async function seedOrganization(): Promise<{
  organizationId: string;
  members: Record<AccountRole, string>;
}> {
  const organizationId = await seedUser('organization');
  await provisionBillingProfile({ accountId: organizationId });
  await recordTopUp({
    idempotencyKey: `bau-route-${tag()}`,
    accountId: organizationId,
    currency: 'USD',
    amount: '25.000000000000',
    actor: { kind: 'machine' },
  });

  const roles: AccountRole[] = ['owner', 'admin', 'editor', 'developer', 'billing', 'viewer'];
  const members = {} as Record<AccountRole, string>;
  for (const role of roles) {
    const memberUserId = await seedUser('personal');
    await getDb()
      .insert(accountMembers)
      .values({ accountId: organizationId, memberUserId, role, inherit: true, status: 'active' });
    members[role] = memberUserId;
  }
  return { organizationId, members };
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

describe('the vacuity floor: a viewer DOES reach this router and is authorised somewhere', () => {
  it('reads the account itself, so every refusal below is the billing gate', async () => {
    const { organizationId, members } = await seedOrganization();
    actingUserId = members.viewer;

    const response = await get(`/accounts/${organizationId}`);
    expect(response.status).toBe(200);
  });
});

describe('the billing trail is gated on billing:read, not on account:read', () => {
  it('refuses a viewer, who holds account:read and no financial permission', async () => {
    const { organizationId, members } = await seedOrganization();
    // The role-table fact that makes this a refusal rather than an accident. If
    // `viewer` ever gains `billing:read`, this line fails before the request
    // does, which is the useful order to learn it in.
    expect(permissionsForAccountRole('viewer')).toContain('account:read');
    expect(permissionsForAccountRole('viewer')).not.toContain('billing:read');

    actingUserId = members.viewer;
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Missing required permission: billing:read');
    // Nothing leaks alongside the refusal.
    expect(response.body.data).toBeUndefined();
  });

  it('refuses a developer, who may mint credentials but may not see the money', async () => {
    const { organizationId, members } = await seedOrganization();
    // The sharper of the two refusals: a developer passes the permission the
    // NEIGHBOURING audit route asks for, so a copy of that route's gate would
    // let them through here.
    expect(permissionsForAccountRole('developer')).toContain('credentials:read');
    expect(permissionsForAccountRole('developer')).not.toContain('billing:read');

    actingUserId = members.developer;
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(403);
  });

  it('serves a member of the billing role', async () => {
    const { organizationId, members } = await seedOrganization();
    expect(permissionsForAccountRole('billing')).toContain('billing:read');

    actingUserId = members.billing;
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.nextCursor).toBeNull();
    const [entry] = response.body.data ?? [];
    expect(entry.kind).toBe('top_up');
    expect(entry.direction).toBe('in');
    expect(entry.actorKind).toBe('machine');
    // The exact decimal reaches the wire as a STRING at the ledger's scale. A
    // JSON number here would mean somebody parsed the money on the way past.
    expect(entry.amount).toBe('25.000000000000');
  });

  it('serves an owner too, so the refusals are about the permission and not the route', async () => {
    const { organizationId, members } = await seedOrganization();
    actingUserId = members.owner;
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
  });

  it('refuses a stranger with no membership at all', async () => {
    const { organizationId } = await seedOrganization();
    actingUserId = await seedUser('personal');
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(403);
  });
});

describe('the query is validated at the boundary, not inside the handler', () => {
  it('rejects a limit past the maximum with a 400 rather than clamping it', async () => {
    const { organizationId, members } = await seedOrganization();
    actingUserId = members.billing;
    const response = await get(`/accounts/${organizationId}/billing/audit?limit=201`);
    expect(response.status).toBe(400);
  });

  it('accepts the default request, which the schema must parse from its own output', async () => {
    // `middleware/validate.ts` writes the parsed query back onto `req.query` and
    // the handler parses it AGAIN. A schema that cannot read what it produced
    // raises `invalid_type` inside the handler — a 500 on a read, which is how
    // `GET /billing/cost-centers` answered every request for as long as it
    // existed. This case is the end-to-end form of that: a 200 here means the
    // second parse survived.
    const { organizationId, members } = await seedOrganization();
    actingUserId = members.billing;
    const response = await get(`/accounts/${organizationId}/billing/audit`);
    expect(response.status).toBe(200);
  });
});
