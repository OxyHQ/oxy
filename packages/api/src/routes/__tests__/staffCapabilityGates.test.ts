/**
 * The graded staff capabilities are MOUNTED on the billing surfaces, not merely
 * available (#972 section 12, "least-privilege admin roles").
 *
 * `routes/__tests__/inferenceAdmin.test.ts` covers the mechanism —
 * `requireStaffCapability`'s refusal, its per-capability grant, its re-read of
 * `is_staff` from the row. What that file cannot show is that the OTHER two
 * graded surfaces call it: a middleware can be correct and inert, and a factory
 * nobody mounted refuses nothing at all while every test of the factory stays
 * green.
 *
 * ## Each case is a pair, and the pair differs by ONE UPDATE
 *
 * A 403 on a billing route is the least distinctive answer in this API —
 * `requireStaff`, `authorizeAccount` and the service layer all produce one. So
 * every refusal below is asserted on the capability guard's OWN message, and is
 * paired with the identical request after a single `staff_capabilities` grant,
 * which must be ANSWERED. Without that second half, "403" would also be what a
 * broken fixture, an unmounted router or a rejected body reports.
 *
 * The staff row is real (`is_staff = true` in the database, not only on the
 * mocked `req.user`) because the guard re-reads it — see
 * `middleware/requireStaff.ts` for why it reads the row rather than the cached
 * account document.
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
    req.user = { _id: currentUserId, id: currentUserId, isStaff: true };
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

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users, type StaffCapability } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { provisionBillingProfile } from '../../services/inferenceLedger.service';
import accountBillingRouter from '../accountBilling';
import costCentersRouter from '../costCenters';

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
          } catch (error) {
            reject(error);
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

/** A staff account holding exactly the capabilities named. */
async function seedStaff(capabilities: readonly StaffCapability[]): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `cap-${tag()}`,
      isStaff: true,
      staffCapabilities: [...capabilities],
    })
    .returning({ id: users.id });
  return row.id;
}

async function grant(userId: string, capability: StaffCapability): Promise<void> {
  await getDb()
    .update(users)
    .set({ staffCapabilities: [capability] })
    .where(eq(users.id, userId));
}

/** An ordinary account with a prepaid billing profile, so a grant can land. */
async function seedFundableAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `acct-${tag()}` })
    .returning({ id: users.id });
  await provisionBillingProfile({ accountId: row.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  // Mounted in the order `server.ts` mounts them: the literal segment first, so
  // `cost-centers` is not captured as an account id.
  app.use('/billing/cost-centers', costCentersRouter);
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

/* -------------------------------------------------------------------------- */
/*  billing:cost_centers                                                      */
/* -------------------------------------------------------------------------- */

describe('registering and retiring a cost centre requires billing:cost_centers', () => {
  const REFUSAL = 'requires the billing:cost_centers staff capability';

  it('refuses a capability-less staff member, and registers for the same account once granted', async () => {
    const accountId = await seedFundableAccount();
    const slug = `cc-${tag()}`;
    currentUserId = await seedStaff([]);

    const refused = await request('POST', '/billing/cost-centers', {
      accountId,
      slug,
      label: 'Research',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(REFUSAL));

    await grant(currentUserId, 'billing:cost_centers');
    const allowed = await request('POST', '/billing/cost-centers', {
      accountId,
      slug,
      label: 'Research',
    });
    expect(allowed.status).toBe(201);
  });

  it('refuses a retire on the same terms', async () => {
    const accountId = await seedFundableAccount();
    const slug = `cc-${tag()}`;
    currentUserId = await seedStaff(['billing:cost_centers']);
    expect((await request('POST', '/billing/cost-centers', { accountId, slug, label: 'X' })).status).toBe(201);

    currentUserId = await seedStaff([]);
    const refused = await request('DELETE', `/billing/cost-centers/${slug}`);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(REFUSAL));

    await grant(currentUserId, 'billing:cost_centers');
    const allowed = await request('DELETE', `/billing/cost-centers/${slug}`);
    expect(allowed.status).toBe(200);
  });

  it('leaves the READS on the plain staff flag', async () => {
    currentUserId = await seedStaff([]);
    const listed = await request('GET', '/billing/cost-centers');
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.data)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  billing:adjust                                                            */
/* -------------------------------------------------------------------------- */

describe('creating balance out of nothing requires billing:adjust', () => {
  const REFUSAL = 'requires the billing:adjust staff capability';

  it('refuses a promotional grant from a capability-less staff member, and records it once granted', async () => {
    const accountId = await seedFundableAccount();
    currentUserId = await seedStaff([]);

    const refused = await request('POST', `/billing/accounts/${accountId}/grants`, {
      amount: '5.00',
      idempotencyKey: `cap-refused-${tag()}`,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(REFUSAL));

    await grant(currentUserId, 'billing:adjust');
    const allowed = await request('POST', `/billing/accounts/${accountId}/grants`, {
      amount: '5.00',
      idempotencyKey: `cap-allowed-${tag()}`,
    });
    // 201 recorded, or 200 for a replayed key. Either is the handler answering,
    // which is the whole claim; the ledger's own semantics are tested where the
    // ledger is.
    expect([200, 201]).toContain(allowed.status);
  });

  it('refuses a capability granted for a DIFFERENT surface', async () => {
    const accountId = await seedFundableAccount();
    // A real, valid grant — for the catalogue. Without this case, holding any
    // capability at all would be indistinguishable from holding this one.
    currentUserId = await seedStaff(['inference:catalogue:publish']);

    const refused = await request('POST', `/billing/accounts/${accountId}/grants`, {
      amount: '5.00',
      idempotencyKey: `cap-wrong-${tag()}`,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(REFUSAL));
  });

  it('gates closing an invoice period too', async () => {
    const accountId = await seedFundableAccount();
    currentUserId = await seedStaff([]);

    const refused = await request('POST', `/billing/accounts/${accountId}/invoices`, {
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(REFUSAL));

    // CONTROL: granted, the request reaches the handler, which refuses a PREPAID
    // account on its own terms — a different status and a different message. The
    // point is that the capability guard is no longer what answered.
    await grant(currentUserId, 'billing:adjust');
    const reached = await request('POST', `/billing/accounts/${accountId}/invoices`, {
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    });
    expect(reached.status).not.toBe(403);
    expect(JSON.stringify(reached.body)).not.toContain('staff capability');
  });
});
