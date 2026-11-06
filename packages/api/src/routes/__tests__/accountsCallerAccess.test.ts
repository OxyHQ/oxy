import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
/**
 * `GET /accounts/:id` carries `callerAccess`: the caller's EFFECTIVE access —
 * the very answer `requireAccountPermission` gates on — in the
 * `AccountAccessGrant` contract shape (`@oxy.so/contracts`).
 *
 * It exists because `callerMembership` cannot carry it. For `self` (a person's
 * own personal account) there is no membership row, so `callerMembership` is
 * `null` and a client reading `callerMembership.permissions` concluded the
 * owner of the account could do nothing in it. `OxyServer.accountAccessFor`
 * (`@oxy.so/core/server`) reads this field and nothing else.
 *
 * The real router over real Postgres with the real `account.service`, as in
 * `accountsBillingAuditAuthorization.test.ts`.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

let actingUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
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

jest.setTimeout(60_000);

let server: http.Server;

interface CallerAccess {
  role: string;
  permissions: string[];
  status: string;
  source: string;
}

interface JsonResponse {
  status: number;
  body: {
    account?: {
      accountId: string;
      relationship: string;
      callerMembership: unknown;
      callerAccess?: CallerAccess;
    };
  };
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
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedUser(kind: 'personal' | 'organization'): Promise<string> {
  const [row] = await insertAccountFixtures(
    { username: `aca-${kind}-${tag()}`, kind },
    { id: users.id },
  );
  return row.id;
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

describe('GET /accounts/:id — callerAccess', () => {
  it('answers a person on their own personal account as its owner, with no membership row', async () => {
    const personId = await seedUser('personal');
    actingUserId = personId;

    const response = await get(`/accounts/${personId}`);
    expect(response.status).toBe(200);
    expect(response.body.account?.relationship).toBe('self');
    expect(response.body.account?.callerMembership).toBeNull();
    const access = response.body.account?.callerAccess;
    expect(access).toEqual({
      role: 'owner',
      permissions: expect.any(Array),
      status: 'active',
      source: 'self',
    });
    expect([...(access?.permissions ?? [])].sort()).toEqual(
      [...permissionsForAccountRole('owner')].sort(),
    );
  });

  it.each<AccountRole>(['viewer', 'admin'])(
    'answers a direct %s with the effective permissions of the role',
    async (role) => {
      const organizationId = await seedUser('organization');
      const memberUserId = await seedUser('personal');
      await getDb()
        .insert(accountMembers)
        .values({ accountId: organizationId, memberUserId, role, inherit: true, status: 'active' });
      actingUserId = memberUserId;

      const response = await get(`/accounts/${organizationId}`);
      expect(response.status).toBe(200);
      const access = response.body.account?.callerAccess;
      expect(access?.role).toBe(role);
      expect(access?.source).toBe('direct');
      expect(access?.status).toBe('active');
      expect([...(access?.permissions ?? [])].sort()).toEqual(
        [...permissionsForAccountRole(role)].sort(),
      );
    },
  );

  it('answers a stranger 403 with no access in the body', async () => {
    const organizationId = await seedUser('organization');
    actingUserId = await seedUser('personal');
    const response = await get(`/accounts/${organizationId}`);
    expect(response.status).toBe(403);
    expect(response.body.account).toBeUndefined();
  });
});
