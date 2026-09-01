/**
 * `/reputation` READ authorization, against a REAL Postgres.
 *
 * Two distinct leaks are guarded here, and both are about WHO may read what:
 *
 *  - `GET /:userId/transactions` used to serve ANY user's ledger to ANY
 *    authenticated caller. A transaction's `metadata` names third parties — the
 *    attestor who physically met the subject, the staking voucher, the full
 *    juror roster of a resolved validation — so the ledger is owner-or-staff.
 *  - `GET /:userId/balance` used to serve `reliability` (abuseScore,
 *    reportAccuracyScore, report counts) and the `influence` weights to
 *    ANONYMOUS callers, for any subject enumerable by id or publicKey. The
 *    endpoint stays public; the RESPONSE is view-split.
 *
 * The previous version mocked `reputation.service` wholesale, so it asserted
 * that a stub had not been called — never that a real ledger row was withheld,
 * and never that the numbers a caller does receive are the right ones. The
 * service is fully ported, so it runs for real here: rows are seeded, the real
 * balance recomputation runs, and the response is checked against the
 * `@oxyhq/contracts` schemas.
 *
 * The auth middleware is the one mock: it attaches the caller a test selects,
 * which is exactly its production contract.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import {
  reputationBalanceSchema,
  reputationBalanceSummarySchema,
  reputationTransactionSchema,
  safeParseContract,
} from '@oxyhq/contracts';

/** The caller the mocked auth middleware attaches, or `undefined` for anonymous. */
let currentCaller: { _id: string; isStaff?: boolean } | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; isStaff?: boolean } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!currentCaller) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    req.user = currentCaller;
    next();
  },
  serviceAuthMiddleware: jest.fn(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (
    req: { user?: { _id: string; isStaff?: boolean } },
    _res: unknown,
    next: () => void,
  ) => {
    if (currentCaller) req.user = currentCaller;
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import reputationRouter from '../reputation.routes';

interface JsonResponse {
  status: number;
  raw: string;
  body: {
    error?: string;
    message?: string;
    data?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
}

/** Every field the public balance view must WITHHOLD. */
const PRIVATE_BALANCE_FIELDS = [
  'positive',
  'negative',
  'breakdown',
  'influence',
  'reliability',
  'recalculatedAt',
  'updatedAt',
] as const;

let server: http.Server;

function get(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        // Close each socket after its response so the server has no lingering
        // keep-alive connections at teardown.
        headers: { connection: 'close' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** One `active` ledger entry naming third parties in its metadata. */
async function ledgerEntry(
  userId: string,
  overrides: Partial<typeof reputationTransactions.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(reputationTransactions)
    .values({
      userId,
      points: 25,
      actionType: 'real_life_attested',
      category: 'physical',
      metadata: { voterUserIds: ['juror-alpha', 'juror-beta'], attestor: 'attestor-gamma' },
      ...overrides,
    })
    .returning({ id: reputationTransactions.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/reputation', reputationRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  currentCaller = undefined;
});

describe('GET /reputation/:userId/transactions — ownership gate', () => {
  it("refuses an authenticated caller reading someone else's ledger", async () => {
    const subject = await account();
    await ledgerEntry(subject);
    currentCaller = { _id: await account() };

    const res = await get(`/reputation/${subject}/transactions`);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own/i);
  });

  it('never leaks the juror roster to a non-owner', async () => {
    const subject = await account();
    await ledgerEntry(subject);
    currentCaller = { _id: await account() };

    const res = await get(`/reputation/${subject}/transactions`);

    expect(res.raw).not.toContain('juror-alpha');
    expect(res.raw).not.toContain('attestor-gamma');
  });

  it('rejects an anonymous caller', async () => {
    const subject = await account();

    const res = await get(`/reputation/${subject}/transactions`);

    expect(res.status).toBe(401);
  });

  it('serves the subject their own ledger, metadata included', async () => {
    const subject = await account();
    const entryId = await ledgerEntry(subject);
    currentCaller = { _id: subject };

    const res = await get(`/reputation/${subject}/transactions`);

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entryId);
    expect(rows[0].userId).toBe(subject);
    expect(rows[0].points).toBe(25);
    expect(rows[0].actionType).toBe('real_life_attested');
    expect(rows[0].category).toBe('physical');
    expect(rows[0].status).toBe('active');
    expect(rows[0].metadata).toEqual({
      voterUserIds: ['juror-alpha', 'juror-beta'],
      attestor: 'attestor-gamma',
    });
    expect(safeParseContract(reputationTransactionSchema, rows[0])).not.toBeNull();
  });

  it("serves staff another user's ledger", async () => {
    const subject = await account();
    await ledgerEntry(subject);
    currentCaller = { _id: await account(), isStaff: true };

    const res = await get(`/reputation/${subject}/transactions`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('resolves the subject by publicKey as well as by id', async () => {
    const publicKey = `04${randomUUID().replace(/-/g, '')}`;
    const subject = await account({ publicKey });
    await ledgerEntry(subject);
    currentCaller = { _id: subject };

    const res = await get(`/reputation/${publicKey}/transactions`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("serves only the subject's own rows, never another account's", async () => {
    const subject = await account();
    const stranger = await account();
    await ledgerEntry(subject);
    await ledgerEntry(stranger);
    currentCaller = { _id: subject };

    const res = await get(`/reputation/${subject}/transactions`);

    const rows = res.body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(subject);
  });
});

describe('GET /reputation/:userId/balance — view split', () => {
  it('withholds the sensitive fields from an anonymous caller', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });

    const res = await get(`/reputation/${subject}/balance`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    for (const field of PRIVATE_BALANCE_FIELDS) {
      expect(data).not.toHaveProperty(field);
    }
  });

  it('keeps the public trust signal readable without a token', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });

    const res = await get(`/reputation/${subject}/balance`);

    expect(res.body.data).toEqual({ userId: subject, total: 120, trustTier: 'trusted' });
    expect(safeParseContract(reputationBalanceSummarySchema, res.body.data)).not.toBeNull();
  });

  it('withholds the sensitive fields from an authenticated third party', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });
    currentCaller = { _id: await account() };

    const res = await get(`/reputation/${subject}/balance`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    for (const field of PRIVATE_BALANCE_FIELDS) {
      expect(data).not.toHaveProperty(field);
    }
  });

  it('serves the subject their own full balance', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });
    currentCaller = { _id: subject };

    const res = await get(`/reputation/${subject}/balance`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.userId).toBe(subject);
    expect(data.total).toBe(120);
    expect(data.positive).toBe(120);
    expect(data.negative).toBe(0);
    expect(data.trustTier).toBe('trusted');
    expect(data.breakdown).toEqual({
      content: 0,
      social: 0,
      trust: 120,
      moderation: 0,
      physical: 0,
      penalties: 0,
    });
    expect(data.influence).toEqual(expect.objectContaining({ defaultWeight: expect.any(Number) }));
    expect(data.reliability).toEqual(expect.objectContaining({ abuseScore: expect.any(Number) }));
    expect(safeParseContract(reputationBalanceSchema, data)).not.toBeNull();
  });

  it("serves staff another user's full balance", async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });
    currentCaller = { _id: await account(), isStaff: true };

    const res = await get(`/reputation/${subject}/balance`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data).toHaveProperty('reliability');
    expect(data).toHaveProperty('influence');
  });

  it('hides from a non-subject the penalty history the total alone conceals', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });
    await ledgerEntry(subject, { points: -20, actionType: 'vouch_slashed', category: 'penalty' });

    const anonymous = await get(`/reputation/${subject}/balance`);
    currentCaller = { _id: subject };
    const own = await get(`/reputation/${subject}/balance`);

    // Both see the same total; only the subject sees the sanctions inside it.
    expect((anonymous.body.data as Record<string, unknown>).total).toBe(100);
    const ownData = own.body.data as Record<string, unknown>;
    expect(ownData.total).toBe(100);
    expect(ownData.negative).toBe(-20);
    expect(ownData.breakdown).toEqual(expect.objectContaining({ trust: 120, penalties: 20 }));
  });
});

describe('GET /reputation/:userId/influence — ownership gate', () => {
  it("refuses an authenticated caller reading someone else's influence", async () => {
    const subject = await account();
    currentCaller = { _id: await account() };

    const res = await get(`/reputation/${subject}/influence`);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own influence/i);
  });

  it('rejects an anonymous caller', async () => {
    const subject = await account();

    const res = await get(`/reputation/${subject}/influence`);

    expect(res.status).toBe(401);
  });

  it('serves the subject their own influence', async () => {
    const subject = await account();
    await ledgerEntry(subject, { points: 120, actionType: 'peer_validated', category: 'trust' });
    currentCaller = { _id: subject };

    const res = await get(`/reputation/${subject}/influence`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.context).toBe('default');
    expect(typeof data.weight).toBe('number');
  });

  it("serves staff another user's influence", async () => {
    const subject = await account();
    currentCaller = { _id: await account(), isStaff: true };

    const res = await get(`/reputation/${subject}/influence`);

    expect(res.status).toBe(200);
  });
});
