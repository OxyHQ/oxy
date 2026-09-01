/**
 * `/inference/reporting` against a REAL Postgres (issue #972, workstream 8).
 *
 * Five claims, and every one of them has a POSITIVE CONTROL beside it, because
 * each would also "pass" if the route simply never worked:
 *
 *  1. **A usage aggregate and a billed total are SOURCED DIFFERENTLY.** Proved
 *     with two accounts fixtured in opposite directions: one has telemetry and
 *     no receipts, the other has receipts and no telemetry. A `/spend` that
 *     summed telemetry would report nothing for the second; a `/usage` that read
 *     receipts would report nothing for the first.
 *  2. **An aggregate over more than one row is ARITHMETIC.** `postgres.js`
 *     decodes `bigint` and `numeric` as strings while drizzle types the former
 *     `number`, so a sum done in JavaScript is string concatenation for tokens
 *     and lossy float for money. Every total here is asserted over two rows, so
 *     `3000 + 4000 = 7000` cannot pass as `"30004000"`.
 *  3. **Another account's numbers answer 404, never 403** — so the id space is
 *     not an existence oracle. The owner, on the identical request, gets 200.
 *  4. **A budget write needs `billing:manage`**, and cannot be attached to
 *     another tenant's application by naming its id.
 *  5. **Reservations and charges are separate.** A held reservation appears on
 *     one and never the other, and settling is what moves it.
 *
 * Everything is real except caller identity (`authMiddleware`) and the logger.
 * Every assertion is scoped to accounts this file created, so a sibling suite
 * seeding rows into the shared database cannot move a number here.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string). The
// service-token claims ARE the gate for the application lane, so restore it.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

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

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingProfiles } from '../../db/schema/billingProfiles';
import { inferenceUsageDailyRollups } from '../../db/schema/inferenceUsageDailyRollups';
import { priceVersions } from '../../db/schema/priceVersions';
import { spendingLimits } from '../../db/schema/spendingLimits';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageRefunds } from '../../db/schema/usageRefunds';
import { usageReservations } from '../../db/schema/usageReservations';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import reportingRouter from '../inferenceReporting';
import type { AccountRole } from '../../utils/accountRoles';

let server: http.Server;
let currentUserId = '';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          authorization: `Bearer ${options.token ?? 'user-token'}`,
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function tag(): string {
  return crypto.randomBytes(6).toString('hex');
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function seedAccount(kind: 'personal' | 'organization' | 'project' = 'personal') {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rep-${tag()}`, kind })
    .returning({ id: users.id });
  return row.id;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole
): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId, role, inherit: true, status: 'active' });
}

async function seedChildAccount(parentAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rep-${tag()}`, kind: 'project', parentAccountId })
    .returning({ id: users.id });
  await getDb()
    .insert(userAncestors)
    .values({ userId: row.id, depth: 0, ancestorId: parentAccountId });
  return row.id;
}

async function seedApp(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Reporting ${tag()}`, ownerAccountId, createdByUserId: ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function seedCredential(applicationId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'Cred',
      publicKey: `oxy_dk_${tag()}${tag()}`,
      secretHash: 'hash',
      type: 'confidential',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return row.id;
}

async function seedPriceVersion(): Promise<string> {
  const [row] = await getDb()
    .insert(priceVersions)
    .values({
      status: 'draft',
      modelReference: `fixture/model-${tag()}`,
      provider: `prov${tag()}`,
      effectiveFrom: new Date(),
    })
    .returning({ id: priceVersions.id });
  return row.id;
}

async function provisionBalance(
  accountId: string,
  buckets: {
    purchased?: string;
    promotional?: string;
    reserved?: string;
    invoicedOutstanding?: string;
    billingMode?: 'prepaid' | 'invoiced';
    creditLimit?: string;
  } = {}
): Promise<void> {
  await getDb()
    .insert(billingProfiles)
    .values({
      accountId,
      billingMode: buckets.billingMode ?? 'prepaid',
      ...(buckets.creditLimit === undefined ? {} : { creditLimit: buckets.creditLimit }),
    });
  await getDb()
    .insert(accountBalances)
    .values({
      accountId,
      currency: 'USD',
      purchasedBalance: buckets.purchased ?? '0',
      promotionalBalance: buckets.promotional ?? '0',
      reservedBalance: buckets.reserved ?? '0',
      invoicedOutstanding: buckets.invoicedOutstanding ?? '0',
    });
}

/** The UTC calendar day `offset` days from now, as the `date` column stores it. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The window every report in this file asks for.
 *
 * RELATIVE to now, and open a day into the future, so a fixture settled "now"
 * cannot fall outside it because of the server's timezone — and so nothing here
 * is a date bomb that detonates in a sibling suite.
 */
const RANGE = { from: day(-2), to: day(1) };
const WINDOW = `from=${RANGE.from}&to=${RANGE.to}`;

async function seedRollup(input: {
  accountId: string;
  applicationId: string;
  applicationCredentialId: string;
  requestedModelReference?: string;
  servingProvider?: string;
  outcome?: 'completed' | 'failed';
  day?: string;
  requestCount: number;
  errorCount?: number;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  await getDb()
    .insert(inferenceUsageDailyRollups)
    .values({
      day: input.day ?? day(0),
      accountId: input.accountId,
      applicationId: input.applicationId,
      applicationCredentialId: input.applicationCredentialId,
      environment: 'production',
      requestedModelReference: input.requestedModelReference ?? 'fixture/requested',
      servingProvider: input.servingProvider ?? 'fixture-provider',
      outcome: input.outcome ?? 'completed',
      requestCount: input.requestCount,
      errorCount: input.errorCount ?? 0,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
    });
}

async function seedReceipt(input: {
  accountId: string;
  applicationId: string;
  applicationCredentialId: string;
  priceVersionId: string;
  billedAmount: string;
  resolvedModelReference?: string;
  servingProvider?: string;
  inputTokens?: number;
}): Promise<string> {
  const [row] = await getDb()
    .insert(usageReceipts)
    .values({
      idempotencyKey: `settle-${tag()}${tag()}`,
      accountId: input.accountId,
      applicationId: input.applicationId,
      applicationCredentialId: input.applicationCredentialId,
      requestId: `req-${tag()}`,
      environment: 'production',
      outcome: 'completed',
      usageSource: 'provider_reported',
      inputTokens: input.inputTokens ?? 1000,
      resolvedModelReference: input.resolvedModelReference ?? 'fixture/resolved',
      servingProvider: input.servingProvider ?? 'fixture-provider',
      priceVersionId: input.priceVersionId,
      billedAmount: input.billedAmount,
      currency: 'USD',
      settledAt: new Date(),
    })
    .returning({ id: usageReceipts.id });
  return row.id;
}

async function seedRefund(receiptId: string, accountId: string, amount: string): Promise<void> {
  await getDb()
    .insert(usageRefunds)
    .values({
      idempotencyKey: `refund-${tag()}${tag()}`,
      accountId,
      requestId: `req-${tag()}`,
      subjectKind: 'receipt',
      receiptId,
      reason: 'billing_correction',
      amount,
      currency: 'USD',
    });
}

async function seedReservation(input: {
  accountId: string;
  applicationId: string;
  applicationCredentialId: string;
  priceVersionId: string;
  reservedAmount: string;
  status?: 'held' | 'settled';
}): Promise<string> {
  const [row] = await getDb()
    .insert(usageReservations)
    .values({
      idempotencyKey: `reserve-${tag()}${tag()}`,
      accountId: input.accountId,
      applicationId: input.applicationId,
      applicationCredentialId: input.applicationCredentialId,
      requestId: `req-${tag()}`,
      environment: 'production',
      status: input.status ?? 'held',
      reservedAmount: input.reservedAmount,
      currency: 'USD',
      ceilingPriceVersionId: input.priceVersionId,
      expiresAt: new Date(Date.now() + 300_000),
    })
    .returning({ id: usageReservations.id });
  return row.id;
}

function serviceToken(input: {
  appId: string;
  ownerAccountId: string;
  scopes: string[];
}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: input.appId,
      appName: 'Fixture App',
      credentialId: `cred-${tag()}`,
      ownerAccountId: input.ownerAccountId,
      environment: 'production',
      scopes: input.scopes,
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h' }
  );
}

/** An owner account with one application, one credential and a balance. */
async function seedTenant(options: { balance?: boolean } = {}) {
  const account = await seedAccount('organization');
  const owner = await seedAccount();
  await seedMember(account, owner, 'owner');
  const applicationId = await seedApp(account);
  const credentialId = await seedCredential(applicationId);
  const priceVersionId = await seedPriceVersion();
  if (options.balance !== false) {
    await provisionBalance(account, { purchased: '10', promotional: '2', reserved: '0.5' });
  }
  return { account, owner, applicationId, credentialId, priceVersionId };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/inference/reporting', reportingRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  1. Usage and spend are sourced differently                                */
/* -------------------------------------------------------------------------- */

describe('a usage aggregate and a billed total come from different tables', () => {
  it('telemetry without receipts reports usage and NO spend', async () => {
    const tenant = await seedTenant();
    await seedRollup({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      requestCount: 5,
      inputTokens: 3000,
    });

    currentUserId = tenant.owner;

    const usage = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}`
    );
    expect(usage.status).toBe(200);
    const usageData = usage.body.data as {
      source: string;
      consistency: string;
      rows: { requestCount: number; units: Record<string, number> }[];
    };
    expect(usageData.source).toBe('usage_telemetry_rollups');
    expect(usageData.consistency).toBe('eventual');
    expect(usageData.rows).toHaveLength(1);
    expect(usageData.rows[0].requestCount).toBe(5);
    expect(usageData.rows[0].units.input_tokens).toBe(3000);

    // The discriminator: a spend endpoint that summed telemetry would report
    // something here. The ledger holds nothing, so it reports nothing.
    const spend = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}`
    );
    expect(spend.status).toBe(200);
    const spendData = spend.body.data as {
      source: string;
      consistency: string;
      rows: unknown[];
      totals: unknown[];
    };
    expect(spendData.source).toBe('financial_ledger');
    expect(spendData.consistency).toBe('authoritative');
    expect(spendData.rows).toEqual([]);
    expect(spendData.totals).toEqual([]);
  });

  it('receipts without telemetry report spend and NO usage', async () => {
    const tenant = await seedTenant();
    await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '1.5',
    });

    currentUserId = tenant.owner;

    const spend = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}`
    );
    expect(spend.status).toBe(200);
    const spendData = spend.body.data as {
      rows: { billedAmount: string; receiptCount: number }[];
      totals: { billedAmount: string; netAmount: string }[];
    };
    expect(spendData.rows).toHaveLength(1);
    expect(Number(spendData.rows[0].billedAmount)).toBe(1.5);
    expect(Number(spendData.totals[0].netAmount)).toBe(1.5);

    // …and the usage report, reading only the rollups, has nothing to say.
    const usage = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}`
    );
    expect(usage.status).toBe(200);
    expect((usage.body.data as { rows: unknown[] }).rows).toEqual([]);
  });

  it('a usage response carries no money field at all', async () => {
    const tenant = await seedTenant();
    await seedRollup({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      requestCount: 1,
      inputTokens: 10,
    });
    await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '99',
    });

    currentUserId = tenant.owner;
    const usage = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}`
    );
    expect(usage.status).toBe(200);
    // Named against the receipt's amount specifically: if the usage surface ever
    // started reading receipts, the number is right there in the payload.
    expect(usage.raw).not.toContain('99');
    expect(usage.raw).not.toContain('billedAmount');
    expect(usage.raw).not.toContain('currency');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Aggregates are arithmetic, not concatenation                           */
/* -------------------------------------------------------------------------- */

describe('an aggregate over more than one row adds', () => {
  it('sums token counts rather than concatenating their strings', async () => {
    const tenant = await seedTenant();
    const second = await seedApp(tenant.account);
    const secondCredential = await seedCredential(second);

    await seedRollup({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      requestCount: 2,
      inputTokens: 3000,
      outputTokens: 11,
    });
    await seedRollup({
      accountId: tenant.account,
      applicationId: second,
      applicationCredentialId: secondCredential,
      requestCount: 3,
      inputTokens: 4000,
      outputTokens: 22,
    });

    currentUserId = tenant.owner;
    const usage = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}&groupBy=day`
    );
    expect(usage.status).toBe(200);
    const rows = (usage.body.data as { rows: { requestCount: number; units: Record<string, number> }[] })
      .rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(5);
    // "30004000" is what a JavaScript `+` over two driver-decoded strings gives.
    expect(rows[0].units.input_tokens).toBe(7000);
    expect(rows[0].units.output_tokens).toBe(33);
    expect(typeof rows[0].units.input_tokens).toBe('number');
  });

  it('sums exact decimal money rather than losing it to a float', async () => {
    const tenant = await seedTenant();
    for (const amount of ['0.1', '0.2']) {
      await seedReceipt({
        accountId: tenant.account,
        applicationId: tenant.applicationId,
        applicationCredentialId: tenant.credentialId,
        priceVersionId: tenant.priceVersionId,
        billedAmount: amount,
      });
    }

    currentUserId = tenant.owner;
    const spend = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}&groupBy=day`
    );
    expect(spend.status).toBe(200);
    const totals = (spend.body.data as { totals: { billedAmount: string; receiptCount: number }[] })
      .totals;
    expect(totals).toHaveLength(1);
    expect(totals[0].receiptCount).toBe(2);
    // `0.1 + 0.2 === 0.30000000000000004` in JavaScript. Postgres says 0.3.
    expect(totals[0].billedAmount).toBe('0.300000000000');
  });

  it('subtracts a reversal without counting the receipt twice', async () => {
    const tenant = await seedTenant();
    const receiptId = await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '5',
    });
    // TWO partial reversals against ONE receipt: a join onto the refund rows
    // instead of a lateral would double the receipt's billed amount here.
    await seedRefund(receiptId, tenant.account, '1');
    await seedRefund(receiptId, tenant.account, '0.5');

    currentUserId = tenant.owner;
    const spend = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}`
    );
    const totals = (
      spend.body.data as {
        totals: { billedAmount: string; refundedAmount: string; netAmount: string; receiptCount: number }[];
      }
    ).totals;
    expect(totals[0].receiptCount).toBe(1);
    expect(Number(totals[0].billedAmount)).toBe(5);
    expect(Number(totals[0].refundedAmount)).toBe(1.5);
    expect(Number(totals[0].netAmount)).toBe(3.5);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Account isolation answers 404                                          */
/* -------------------------------------------------------------------------- */

describe('another account is not readable, and is not an existence oracle', () => {
  const surfaces = [
    ['balance', (id: string) => `/inference/reporting/accounts/${id}/balance`],
    ['usage', (id: string) => `/inference/reporting/accounts/${id}/usage?${WINDOW}`],
    ['spend', (id: string) => `/inference/reporting/accounts/${id}/spend?${WINDOW}`],
    ['charges', (id: string) => `/inference/reporting/accounts/${id}/charges?${WINDOW}`],
    ['reservations', (id: string) => `/inference/reporting/accounts/${id}/reservations`],
    ['budgets', (id: string) => `/inference/reporting/accounts/${id}/spending-limits`],
  ] as const;

  test.each(surfaces)('%s answers 404 to a stranger and 200 to the owner', async (_name, path) => {
    const tenant = await seedTenant();
    await seedRollup({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      requestCount: 1,
    });
    const stranger = await seedAccount();

    currentUserId = stranger;
    const refused = await request('GET', path(tenant.account));
    expect(refused.status).toBe(404);
    // Not 403 — the entitlement answer and the existence answer are the same.
    expect(refused.status).not.toBe(403);

    // POSITIVE CONTROL: the identical request from the owner. Without it, a
    // route that 404s for everybody would look exactly like isolation working.
    currentUserId = tenant.owner;
    const permitted = await request('GET', path(tenant.account));
    expect(permitted.status).toBe(200);
  });

  it('answers 404 to a nonexistent account too, so the two are indistinguishable', async () => {
    const stranger = await seedAccount();
    currentUserId = stranger;
    const missing = await request('GET', '/inference/reporting/accounts/does-not-exist/balance');
    expect(missing.status).toBe(404);
  });

  it('refuses a member who can see the account but not its money', async () => {
    const tenant = await seedTenant();
    const developer = await seedAccount();
    await seedMember(tenant.account, developer, 'developer');

    currentUserId = developer;
    const refused = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}`
    );
    // 403, not 404: this caller legitimately reaches the account, and telling
    // them they lack a permission reveals nothing they did not already know.
    expect(refused.status).toBe(403);
    expect(String(refused.body.message)).toContain('billing:read');

    // POSITIVE CONTROL: a member of the same account WITH the permission.
    const analyst = await seedAccount();
    await seedMember(tenant.account, analyst, 'billing');
    currentUserId = analyst;
    const permitted = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spend?${WINDOW}`
    );
    expect(permitted.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Balance, reservations and charges                                      */
/* -------------------------------------------------------------------------- */

describe('a balance keeps purchased, promotional and reserved apart', () => {
  it('reports the three distinctly plus derived headroom', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.owner;

    const response = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/balance`
    );
    expect(response.status).toBe(200);
    const data = response.body.data as {
      provisioned: boolean;
      balances: {
        purchased: string;
        promotional: string;
        reserved: string;
        availableToSpend: string;
      }[];
    };
    expect(data.provisioned).toBe(true);
    expect(data.balances).toHaveLength(1);
    expect(Number(data.balances[0].purchased)).toBe(10);
    expect(Number(data.balances[0].promotional)).toBe(2);
    expect(Number(data.balances[0].reserved)).toBe(0.5);
    // Headroom excludes the hold, and is not the sum of the three.
    expect(Number(data.balances[0].availableToSpend)).toBe(12);
  });

  it('distinguishes an unprovisioned account from a zero balance', async () => {
    const tenant = await seedTenant({ balance: false });
    currentUserId = tenant.owner;

    const response = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/balance`
    );
    expect(response.status).toBe(200);
    const data = response.body.data as { provisioned: boolean; balances: unknown[] };
    expect(data.provisioned).toBe(false);
    expect(data.balances).toEqual([]);
  });
});

describe('a hold is not a charge', () => {
  it('lists a held reservation and never lists it as a charge', async () => {
    const tenant = await seedTenant();
    await seedReservation({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      reservedAmount: '2.25',
    });
    // A settled hold has become a charge and must NOT appear as pending.
    await seedReservation({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      reservedAmount: '9',
      status: 'settled',
    });

    currentUserId = tenant.owner;
    const held = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/reservations`
    );
    expect(held.status).toBe(200);
    const heldData = held.body.data as {
      rows: { reservedAmount: string }[];
      totals: { heldAmount: string; reservationCount: number }[];
    };
    expect(heldData.rows).toHaveLength(1);
    expect(Number(heldData.rows[0].reservedAmount)).toBe(2.25);
    expect(heldData.totals[0].reservationCount).toBe(1);
    expect(Number(heldData.totals[0].heldAmount)).toBe(2.25);

    // The charges list is the other side and is empty: nothing was settled.
    const charges = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/charges?${WINDOW}`
    );
    expect(charges.status).toBe(200);
    expect((charges.body.data as { rows: unknown[] }).rows).toEqual([]);
  });

  it('lists a settled charge with its units and its net amount', async () => {
    const tenant = await seedTenant();
    const receiptId = await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '4',
      inputTokens: 1234,
    });
    await seedRefund(receiptId, tenant.account, '1');

    currentUserId = tenant.owner;
    const charges = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/charges?${WINDOW}`
    );
    expect(charges.status).toBe(200);
    const rows = (
      charges.body.data as {
        rows: {
          receiptId: string;
          billedAmount: string;
          refundedAmount: string;
          netAmount: string;
          units: Record<string, number>;
        }[];
      }
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].receiptId).toBe(receiptId);
    expect(Number(rows[0].billedAmount)).toBe(4);
    expect(Number(rows[0].refundedAmount)).toBe(1);
    expect(Number(rows[0].netAmount)).toBe(3);
    expect(rows[0].units.input_tokens).toBe(1234);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Descendants                                                            */
/* -------------------------------------------------------------------------- */

describe('an organization can see its projects, but only when it asks', () => {
  it('excludes a project by default and includes it on request', async () => {
    const tenant = await seedTenant();
    const project = await seedChildAccount(tenant.account);
    const projectApp = await seedApp(project);
    const projectCredential = await seedCredential(projectApp);
    await seedRollup({
      accountId: project,
      applicationId: projectApp,
      applicationCredentialId: projectCredential,
      requestCount: 7,
    });

    currentUserId = tenant.owner;

    const own = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}`
    );
    expect(own.status).toBe(200);
    expect((own.body.data as { rows: unknown[] }).rows).toEqual([]);

    const subtree = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/usage?${WINDOW}&includeDescendants=true&groupBy=account`
    );
    expect(subtree.status).toBe(200);
    const rows = (subtree.body.data as { rows: { accountId: string; requestCount: number }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(project);
    expect(rows[0].requestCount).toBe(7);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Budgets                                                                */
/* -------------------------------------------------------------------------- */

describe('a budget needs billing:manage and cannot escape its account', () => {
  it('refuses a create from a member who may only read billing', async () => {
    const tenant = await seedTenant();
    const reader = await seedAccount();
    await seedMember(tenant.account, reader, 'admin');

    currentUserId = reader;
    const refused = await request(
      'POST',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`,
      {
        body: {
          scope: 'application',
          scopeApplicationId: tenant.applicationId,
          period: 'monthly',
          limitAmount: '100',
        },
      }
    );
    expect(refused.status).toBe(403);
    expect(String(refused.body.message)).toContain('billing:manage');

    // POSITIVE CONTROL: the identical request from a member who holds it.
    currentUserId = tenant.owner;
    const created = await request(
      'POST',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`,
      {
        body: {
          scope: 'application',
          scopeApplicationId: tenant.applicationId,
          period: 'monthly',
          limitAmount: '100',
          alertThresholdBps: [7500],
        },
      }
    );
    expect(created.status).toBe(201);
    const budget = created.body.data as {
      spendingLimitId: string;
      limitAmount: string;
      alertThresholdBps: number[];
      currentSpend: string;
      remaining: string;
      utilizationBps: number;
    };
    expect(Number(budget.limitAmount)).toBe(100);
    expect(budget.alertThresholdBps).toEqual([7500]);
    expect(Number(budget.currentSpend)).toBe(0);
    expect(Number(budget.remaining)).toBe(100);
    expect(budget.utilizationBps).toBe(0);
  });

  it('refuses a budget pointed at another tenant application', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    currentUserId = mine.owner;
    const refused = await request(
      'POST',
      `/inference/reporting/accounts/${mine.account}/spending-limits`,
      {
        body: {
          scope: 'application',
          scopeApplicationId: theirs.applicationId,
          period: 'monthly',
          limitAmount: '50',
        },
      }
    );
    expect(refused.status).toBe(404);

    // The refusal must be WORD FOR WORD what a nonexistent application gets. A
    // 404 whose message differs by reason is still an oracle: "not yours" and
    // "does not exist" would let a stranger enumerate application ids.
    const missing = await request(
      'POST',
      `/inference/reporting/accounts/${mine.account}/spending-limits`,
      {
        body: {
          scope: 'application',
          scopeApplicationId: 'application-that-does-not-exist',
          period: 'monthly',
          limitAmount: '50',
        },
      }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(refused.body.message);
    // Vacuity floor: the messages agree because a message was sent, not because
    // both were undefined.
    expect(typeof refused.body.message).toBe('string');

    // …and nothing was written for the other tenant's application.
    const stored = await getDb()
      .select({ id: spendingLimits.id })
      .from(spendingLimits)
      .where(eq(spendingLimits.scopeApplicationId, theirs.applicationId));
    expect(stored).toHaveLength(0);
  });

  it('reports utilization from the same query the reservation path enforces with', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.owner;

    const created = await request(
      'POST',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`,
      {
        body: {
          scope: 'application',
          scopeApplicationId: tenant.applicationId,
          period: 'total',
          limitAmount: '10',
        },
      }
    );
    expect(created.status).toBe(201);

    // A settled charge and a live hold both count toward a budget — the hold
    // because a limit blind to in-flight requests can be blown by concurrency.
    await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '2',
    });
    await seedReservation({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      reservedAmount: '3',
    });

    const listed = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`
    );
    expect(listed.status).toBe(200);
    const rows = (
      listed.body.data as {
        rows: { currentSpend: string; remaining: string; utilizationBps: number }[];
      }
    ).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].currentSpend)).toBe(5);
    expect(Number(rows[0].remaining)).toBe(5);
    expect(rows[0].utilizationBps).toBe(5000);
  });

  it('edits a ceiling and refuses to re-point a scope', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.owner;

    const created = await request(
      'POST',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`,
      {
        body: {
          scope: 'account',
          scopeAccountId: tenant.account,
          period: 'daily',
          limitAmount: '20',
        },
      }
    );
    expect(created.status).toBe(201);
    const budgetId = (created.body.data as { spendingLimitId: string }).spendingLimitId;

    const updated = await request(
      'PATCH',
      `/inference/reporting/spending-limits/${budgetId}`,
      { body: { limitAmount: '40', enforcement: 'soft_stop', status: 'disabled' } }
    );
    expect(updated.status).toBe(200);
    const view = updated.body.data as {
      limitAmount: string;
      enforcement: string;
      status: string;
    };
    expect(Number(view.limitAmount)).toBe(40);
    expect(view.enforcement).toBe('soft_stop');
    expect(view.status).toBe('disabled');

    const repointed = await request(
      'PATCH',
      `/inference/reporting/spending-limits/${budgetId}`,
      { body: { scopeAccountId: 'somewhere-else' } }
    );
    expect(repointed.status).toBe(400);
  });

  it('answers 404 when a stranger edits a budget', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.owner;
    const created = await request(
      'POST',
      `/inference/reporting/accounts/${tenant.account}/spending-limits`,
      {
        body: {
          scope: 'account',
          scopeAccountId: tenant.account,
          period: 'weekly',
          limitAmount: '30',
        },
      }
    );
    const budgetId = (created.body.data as { spendingLimitId: string }).spendingLimitId;

    const stranger = await seedAccount();
    currentUserId = stranger;
    const refused = await request(
      'PATCH',
      `/inference/reporting/spending-limits/${budgetId}`,
      { body: { limitAmount: '1000' } }
    );
    expect(refused.status).toBe(404);

    // Same refusal, word for word, as a budget id that does not exist — so the
    // 404 cannot be read as "this id is real, just not yours".
    const missing = await request(
      'PATCH',
      '/inference/reporting/spending-limits/budget-that-does-not-exist',
      { body: { limitAmount: '1000' } }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(refused.body.message);
    expect(typeof refused.body.message).toBe('string');

    // POSITIVE CONTROL: the owner's identical edit succeeds, so the 404 above
    // was the gate rather than a broken route.
    currentUserId = tenant.owner;
    const permitted = await request(
      'PATCH',
      `/inference/reporting/spending-limits/${budgetId}`,
      { body: { limitAmount: '1000' } }
    );
    expect(permitted.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. The application lane and the service-token boundary                    */
/* -------------------------------------------------------------------------- */

describe('a service credential reaches only its own application', () => {
  it('reads its own application usage with inference:usage:read', async () => {
    const tenant = await seedTenant();
    await seedRollup({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      requestCount: 4,
      inputTokens: 42,
    });

    const token = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.account,
      scopes: ['inference:usage:read'],
    });

    const response = await request(
      'GET',
      `/inference/reporting/applications/${tenant.applicationId}/usage?${WINDOW}`,
      { token }
    );
    expect(response.status).toBe(200);
    const rows = (response.body.data as { rows: { requestCount: number }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(4);
  });

  it('refuses a credential without the scope, and answers 404 for another application', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    const unscoped = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.account,
      scopes: ['inference:invoke'],
    });
    const refused = await request(
      'GET',
      `/inference/reporting/applications/${mine.applicationId}/usage?${WINDOW}`,
      { token: unscoped }
    );
    expect(refused.status).toBe(403);
    expect(String(refused.body.message)).toContain('inference:usage:read');

    const scoped = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.account,
      scopes: ['inference:usage:read'],
    });
    const crossTenant = await request(
      'GET',
      `/inference/reporting/applications/${theirs.applicationId}/usage?${WINDOW}`,
      { token: scoped }
    );
    expect(crossTenant.status).toBe(404);

    // POSITIVE CONTROL: the same token on its OWN application.
    const own = await request(
      'GET',
      `/inference/reporting/applications/${mine.applicationId}/usage?${WINDOW}`,
      { token: scoped }
    );
    expect(own.status).toBe(200);
  });

  it('cannot reach the account lane at all, even for its own owner account', async () => {
    const tenant = await seedTenant();
    const token = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.account,
      scopes: ['inference:usage:read'],
    });

    const refused = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/balance`,
      { token }
    );
    expect(refused.status).toBe(404);

    // POSITIVE CONTROL: a person with the same account's `billing:read` can.
    currentUserId = tenant.owner;
    const permitted = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/balance`
    );
    expect(permitted.status).toBe(200);
  });

  it('reports one application spend broken down by resolved model and provider', async () => {
    const tenant = await seedTenant();
    for (const [model, provider, amount] of [
      ['fixture/alpha', 'prov-a', '1'],
      ['fixture/beta', 'prov-b', '2'],
    ] as const) {
      await seedReceipt({
        accountId: tenant.account,
        applicationId: tenant.applicationId,
        applicationCredentialId: tenant.credentialId,
        priceVersionId: tenant.priceVersionId,
        billedAmount: amount,
        resolvedModelReference: model,
        servingProvider: provider,
      });
    }

    currentUserId = tenant.owner;
    const response = await request(
      'GET',
      `/inference/reporting/applications/${tenant.applicationId}/spend?${WINDOW}&groupBy=resolvedModel,provider`
    );
    expect(response.status).toBe(200);
    const rows = (
      response.body.data as {
        rows: { resolvedModelReference: string; servingProvider: string; netAmount: string }[];
      }
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.resolvedModelReference).sort()).toEqual([
      'fixture/alpha',
      'fixture/beta',
    ]);
    expect(rows.map((row) => Number(row.netAmount)).sort()).toEqual([1, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/*  8. Export                                                                 */
/* -------------------------------------------------------------------------- */

describe('the reconciliation export renders the ledger, and only the ledger', () => {
  it('emits one CSV row per settled charge and no wholesale column', async () => {
    const tenant = await seedTenant();
    await seedReceipt({
      accountId: tenant.account,
      applicationId: tenant.applicationId,
      applicationCredentialId: tenant.credentialId,
      priceVersionId: tenant.priceVersionId,
      billedAmount: '7.25',
      inputTokens: 55,
    });

    currentUserId = tenant.owner;
    const response = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/charges/export?${WINDOW}`
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['x-oxy-export-truncated']).toBe('false');

    const lines = response.raw.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"billed_amount"');
    expect(lines[0]).toContain('"net_amount"');
    expect(lines[0]).toContain('"input_tokens"');
    expect(lines[0].toLowerCase()).not.toContain('wholesale');
    expect(lines[0].toLowerCase()).not.toContain('upstream');
    expect(lines[1]).toContain('"7.250000000000"');
    expect(lines[1]).toContain('"55"');
  });

  it('refuses a stranger the same way the JSON surface does', async () => {
    const tenant = await seedTenant();
    const stranger = await seedAccount();
    currentUserId = stranger;
    const refused = await request(
      'GET',
      `/inference/reporting/accounts/${tenant.account}/charges/export?${WINDOW}`
    );
    expect(refused.status).toBe(404);
  });
});
