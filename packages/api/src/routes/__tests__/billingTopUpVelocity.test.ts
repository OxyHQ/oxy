/**
 * Top-up attempts are bounded PER BILLING PROFILE (#972 sections 8 and 12, "rate
 * limits and fraud controls before enabling prepaid public inference").
 *
 * ## The case that justifies the limiter existing at all
 *
 * `POST /billing/accounts/:accountId/checkout` already had a limiter, keyed on
 * `hashedIpKey`. Two things defeat it, and both are the ordinary shape of card
 * abuse rather than an exotic one:
 *
 *  - the same profile probed from many addresses, which multiplies the IP budget
 *    by the number of addresses;
 *  - the same PAYER addressed through many account ids, because a project that
 *    inherits its organization's billing profile can be named by any account in
 *    the subtree — many ids, one payer, one card.
 *
 * The second is the load-bearing case here (`exhausts the budget through a CHILD
 * project`), and it is the one an account-id-keyed or path-keyed limiter cannot
 * answer. Without it this file would be a test that a rate limiter counts.
 *
 * ## The rate limiter is NOT mocked in this file, deliberately
 *
 * Every other route suite mocks `middleware/rateLimiter` away, which is right for
 * a suite about a handler and useless for one about a budget. Redis is unset
 * locally, so `rateLimit` falls back to express-rate-limit's in-memory store —
 * the counting is real, the key derivation is real, and the middleware order is
 * real. Stripe is the only thing stubbed, because a checkout session is not what
 * is being measured.
 *
 * ## Every ceiling assertion is paired with a control
 *
 * A limiter that refused everything would satisfy "the eleventh is refused" just
 * as well as a correct one, so each case also asserts what must still be SERVED:
 * the ten before it, and a different profile after the first is exhausted.
 */

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

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

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redirectAllowlist', () => ({ isAllowedRedirect: () => true }));

/**
 * The PRE-EXISTING, IP-keyed checkout limiter is neutralised — and only it.
 *
 * `billingCheckoutLimiter` uses the factory's default key generator,
 * `hashedIpKey`, and caps at 20 per 15 minutes. Every request in this file comes
 * from 127.0.0.1, so that budget would fire partway through and every 429 below
 * would be evidence about the wrong limiter. Giving `hashedIpKey` a fresh value
 * per call retires it for the duration.
 *
 * `rateLimit` itself is NOT mocked, so the profile-keyed limiter under test counts
 * for real — and because the IP budget can no longer fire, a 429 anywhere in this
 * file can only have come from `topUpVelocityLimiter`.
 */
jest.mock('../../utils/ipKey', () => ({
  hashedIpKey: () => `unmetered-${crypto.randomBytes(8).toString('hex')}`,
}));

/**
 * The one thing stubbed. A hosted checkout is a Stripe round trip and the subject
 * here is the budget in front of it — but the stub answers SUCCESS, so a served
 * request is a 200 and cannot be confused with a refusal.
 */
jest.mock('../../services/stripeAccountBilling.service', () => ({
  createBalanceTopUpCheckout: jest.fn(async () => ({
    status: 'created',
    sessionId: 'cs_test_stub',
    url: 'https://checkout.stripe.test/session',
  })),
  createAccountPortalSession: jest.fn(async () => 'https://billing.stripe.test/portal'),
  stripePaymentProcessorLedger: jest.fn(() => ({
    provider: 'stripe',
    listSettledPayments: async () => [],
  })),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { userAncestors, users } from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { provisionBillingProfile } from '../../services/inferenceLedger.service';
import accountBillingRouter from '../accountBilling';

jest.setTimeout(60_000);

let server: http.Server;
let currentUserId = '';

/** The limiter's ceiling, mirrored so the arithmetic below is readable. */
const MAX_TOP_UPS_PER_HOUR = 10;

interface HttpResponse {
  status: number;
  /** Raw, because a 429 from express-rate-limit is plain text, not JSON. */
  raw: string;
}

function request(path: string): Promise<HttpResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify({
    amount: '10.00',
    successUrl: 'https://oxy.so/ok',
    cancelUrl: 'https://oxy.so/no',
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
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
          resolve({ status: res.statusCode ?? 0, raw });
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
    .values({ username: `topup-${tag()}`, kind, parentAccountId })
    .returning({ id: users.id });
  if (parentAccountId !== undefined) {
    await getDb()
      .insert(userAncestors)
      .values([{ userId: row.id, ancestorId: parentAccountId, depth: 0 }]);
  }
  return row.id;
}

/** `billing` carries exactly `billing:read` + `billing:manage`. */
async function seedMember(accountId: string, memberUserId: string): Promise<void> {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId,
    role: 'billing',
    inherit: true,
    status: 'active',
  });
}

/** A funded organization with a project that INHERITS its profile. */
async function seedPayerWithChild(): Promise<{
  organizationId: string;
  projectId: string;
  adminId: string;
}> {
  const organizationId = await seedAccount('organization');
  const projectId = await seedAccount('project', organizationId);
  await provisionBillingProfile({ accountId: organizationId });
  const adminId = await seedAccount('personal');
  await seedMember(organizationId, adminId);
  return { organizationId, projectId, adminId };
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
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

describe('top-up velocity is bounded per billing profile', () => {
  it('serves the budget and refuses the attempt past it', async () => {
    const payer = await seedPayerWithChild();
    currentUserId = payer.adminId;
    const path = `/billing/accounts/${payer.organizationId}/checkout`;

    for (let attempt = 1; attempt <= MAX_TOP_UPS_PER_HOUR; attempt += 1) {
      const served = await request(path);
      // The control on the ceiling: a limiter that refused from the first attempt
      // would satisfy the 429 below just as well.
      expect(served.status).toBe(200);
    }

    const refused = await request(path);
    expect(refused.status).toBe(429);
    // The refusal is the top-up limiter's own message, not the general one — the
    // IP-keyed budget is retired in this file, and this pins which limiter spoke.
    expect(refused.raw).toContain('Too many top-up attempts for this billing profile');
  });

  it('exhausts the budget through a CHILD project — the case an account-keyed limiter misses', async () => {
    const payer = await seedPayerWithChild();
    currentUserId = payer.adminId;

    // Every attempt names the PROJECT, which has no profile of its own and
    // resolves to the organization's. A limiter keyed on the path account id, or
    // on the account being addressed, would give this project its own fresh
    // budget — and so would give one card as many budgets as the subtree has
    // accounts.
    for (let attempt = 1; attempt <= MAX_TOP_UPS_PER_HOUR; attempt += 1) {
      const served = await request(`/billing/accounts/${payer.projectId}/checkout`);
      expect(served.status).toBe(200);
    }

    // Refused on the PARENT's path, having only ever been spent on the child's.
    const refused = await request(`/billing/accounts/${payer.organizationId}/checkout`);
    expect(refused.status).toBe(429);
  });

  it('does not spend one profile’s budget on another — the positive control on the key', async () => {
    const first = await seedPayerWithChild();
    currentUserId = first.adminId;
    const firstPath = `/billing/accounts/${first.organizationId}/checkout`;

    for (let attempt = 1; attempt <= MAX_TOP_UPS_PER_HOUR; attempt += 1) {
      expect((await request(firstPath)).status).toBe(200);
    }
    expect((await request(firstPath)).status).toBe(429);

    // A different profile, from the same address and through the same limiter, is
    // untouched. Without this the case above would also pass against a single
    // global bucket, which would let any customer lock out every other.
    const second = await seedPayerWithChild();
    currentUserId = second.adminId;
    const secondServed = await request(`/billing/accounts/${second.organizationId}/checkout`);
    expect(secondServed.status).toBe(200);
  });

  it('does not spend the budget of a profile the caller may not reach', async () => {
    const payer = await seedPayerWithChild();
    const stranger = await seedAccount('personal');
    currentUserId = stranger;
    const path = `/billing/accounts/${payer.organizationId}/checkout`;

    // Refused for lack of authority, not for velocity — the payer is resolved and
    // authorised BEFORE the limiter, so a stranger cannot exhaust somebody else's
    // budget by hammering their account id.
    for (let attempt = 1; attempt <= MAX_TOP_UPS_PER_HOUR + 2; attempt += 1) {
      const refused = await request(path);
      expect(refused.status).toBe(404);
    }

    // CONTROL: the owner's own budget is intact after all of that.
    currentUserId = payer.adminId;
    expect((await request(path)).status).toBe(200);
  });
});
