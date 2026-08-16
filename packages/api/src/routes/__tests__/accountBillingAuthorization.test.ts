/**
 * Authority over a payer-owned record is the PAYER's, not the path account's.
 *
 * ## The escalation this guards
 *
 * Inheritance is the vector. A project that draws on its organization's billing
 * profile has none of its own, so every route that reaches a spending limit, an
 * invoice, a charge history or a checkout has to resolve the ORGANIZATION first.
 * Authorising the path account and then operating on the resolved payer means a
 * member whose membership exists only on the project — `billing:manage` there,
 * nothing at all on the organization — can raise, disable or delete the
 * organization's budgets by id, aim a `hard_stop` at a sibling project's
 * application, and read the organization's invoices.
 *
 * ## Every refusal has a CONTROL that differs by one fixture field
 *
 * A 404 because the fixture never reached the route looks exactly like a 404
 * because the gate fired. So each case is a pair: the same seeded graph and the
 * same request, once as the project-only member and once as the organization
 * admin. And `GET /billing/accounts/:projectId` is asserted to SUCCEED for the
 * project-only member — the vacuity floor for the whole file, proving that
 * member's bearer reaches this router and is authorised somewhere, so the
 * refusals below are the gate rather than a broken fixture.
 *
 * Reading the balance you spend from IS the inheritance feature, which is why
 * that one succeeds while moving a ceiling does not.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string; isStaff: boolean } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: currentUserId, id: currentUserId, isStaff: false };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redirectAllowlist', () => ({ isAllowedRedirect: () => true }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials, applications, userAncestors, users } from '../../db/schema';
import accountBillingRouter from '../accountBilling';
import { errorHandler } from '../../middleware/errorHandler';
import { provisionBillingProfile } from '../../services/inferenceLedger.service';

jest.setTimeout(60_000);

let server: http.Server;
let currentUserId = '';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
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

function tag(): string {
  return crypto.randomBytes(6).toString('hex');
}

async function seedAccount(
  kind: 'personal' | 'organization' | 'project',
  parentAccountId?: string
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `bill-${tag()}`, kind, parentAccountId })
    .returning({ id: users.id });

  if (parentAccountId !== undefined) {
    await getDb()
      .insert(userAncestors)
      .values([{ userId: row.id, ancestorId: parentAccountId, depth: 0 }]);
  }
  return row.id;
}

async function seedMember(accountId: string, memberUserId: string): Promise<void> {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId,
    /*
     * `billing`, not `admin`. The role carries exactly `billing:read` and
     * `billing:manage` (`utils/accountRoles.ts`), which is the SHARPEST fixture
     * for this file: every refusal below is then about WHERE the membership sits
     * and never about what the role grants.
     *
     * `admin` would have made the whole file pass for the wrong reason — it
     * holds `billing:read` and NOT `billing:manage`, so the writes would 403 on
     * the permission check whether or not the payer gate existed.
     */
    role: 'billing',
    inherit: true,
    status: 'active',
  });
}

async function seedApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${tag()}`, ownerAccountId })
    .returning({ id: applications.id });
  await getDb().insert(applicationCredentials).values({
    applicationId: row.id,
    name: 'test',
    publicKey: `oxy_dk_${crypto.randomBytes(16).toString('hex')}`,
    type: 'service',
    environment: 'production',
  });
  return row.id;
}

/**
 * An organization that pays, a project that inherits, a sibling project, and two
 * people: one who administers the organization and one who administers ONLY the
 * inheriting project.
 */
interface Graph {
  organizationId: string;
  projectId: string;
  siblingId: string;
  siblingApplicationId: string;
  organizationAdminId: string;
  projectAdminId: string;
}

async function seedGraph(): Promise<Graph> {
  const organizationId = await seedAccount('organization');
  const projectId = await seedAccount('project', organizationId);
  const siblingId = await seedAccount('project', organizationId);
  const siblingApplicationId = await seedApplication(siblingId);

  await provisionBillingProfile({ accountId: organizationId });

  const organizationAdminId = await seedAccount('personal');
  const projectAdminId = await seedAccount('personal');
  await seedMember(organizationId, organizationAdminId);
  await seedMember(projectId, projectAdminId);

  return {
    organizationId,
    projectId,
    siblingId,
    siblingApplicationId,
    organizationAdminId,
    projectAdminId,
  };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/billing/accounts', accountBillingRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('the vacuity floor: a project-only member DOES reach this router', () => {
  it('reads the organization balance it spends, marked inherited', async () => {
    const graph = await seedGraph();
    currentUserId = graph.projectAdminId;

    const response = await request('GET', `/billing/accounts/${graph.projectId}`);
    expect(response.status).toBe(200);
    const data = response.body.data as { inherited: boolean; billingAccountId: string };
    expect(data.inherited).toBe(true);
    expect(data.billingAccountId).toBe(graph.organizationId);
  });
});

/*
 * THE BUDGET CASES ARE NOT HERE. `/inference/reporting` owns the spending-limit
 * surface (#972 workstream 8) and authorises each write against the limit's own
 * owner account, which is the same property the cases below assert for the
 * records this router does serve. A second CRUD here would have been a second
 * authorisation rule on a table whose job is to refuse spending.
 */

describe("a project-only member cannot read the organization's financial history", () => {
  it('refuses the invoice list through the project id', async () => {
    const graph = await seedGraph();
    currentUserId = graph.projectAdminId;
    expect((await request('GET', `/billing/accounts/${graph.projectId}/invoices`)).status).toBe(404);

    currentUserId = graph.organizationAdminId;
    expect((await request('GET', `/billing/accounts/${graph.projectId}/invoices`)).status).toBe(200);
  });

  it("refuses the auto-recharge history — what was charged to the organization's card", async () => {
    const graph = await seedGraph();
    currentUserId = graph.projectAdminId;
    expect(
      (await request('GET', `/billing/accounts/${graph.projectId}/auto-recharge`)).status
    ).toBe(404);

    currentUserId = graph.organizationAdminId;
    expect(
      (await request('GET', `/billing/accounts/${graph.projectId}/auto-recharge`)).status
    ).toBe(200);
  });
});

describe('a top-up is refused before it can be charged into nowhere', () => {
  it('refuses a currency the billing profile does not use', async () => {
    const graph = await seedGraph();
    currentUserId = graph.organizationAdminId;

    // The profile is USD. A EUR checkout would be charged and then find no
    // `account_balances` row to credit — the customer pays and the balance never
    // moves. Refused BEFORE any processor call, which is why this test needs no
    // Stripe account.
    const response = await request('POST', `/billing/accounts/${graph.organizationId}/checkout`, {
      amount: '20.000000000000',
      currency: 'EUR',
      successUrl: 'https://console.oxy.so/ok',
      cancelUrl: 'https://console.oxy.so/no',
    });
    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain('USD');
  });

  it('refuses a checkout from a member with no authority over the payer', async () => {
    const graph = await seedGraph();
    currentUserId = graph.projectAdminId;

    const response = await request('POST', `/billing/accounts/${graph.projectId}/checkout`, {
      amount: '20.000000000000',
      successUrl: 'https://console.oxy.so/ok',
      cancelUrl: 'https://console.oxy.so/no',
    });
    expect(response.status).toBe(404);
  });
});
