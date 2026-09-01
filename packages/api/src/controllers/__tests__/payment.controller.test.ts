/**
 * `GET /payments/user`, against a REAL Postgres.
 *
 * ## The two things the port could break silently
 *
 * **`amount` must stay a JSON NUMBER.** The column is `numeric(38, 8)` and
 * postgres.js hands a `numeric` back as a STRING, so the naive port ships
 * `"amount": "25.50000000"` where the published `Payment` contract
 * (`@oxyhq/services`) says `amount: number`. The assertions here check the
 * emitted TYPE, not just the value — `"25.5" == 25.5` is true in JS, so a value
 * comparison alone would pass against the bug.
 *
 * **An absent optional must stay OMITTED.** Mongoose returned `undefined` for an
 * unset `description`/`itemId`/`itemType`/`completedAt` and `JSON.stringify`
 * dropped the key; drizzle returns `null`, which `JSON.stringify` EMITS. Every
 * field of that contract is `?:`, so a `null` is a wire change. The body is
 * asserted whole, key set included.
 *
 * The auth middleware is mocked; the ledger rows, the `numeric` scale and the
 * ordering are the real database.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/** The account each request authenticates as. Set per test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string; _id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId, _id: currentUserId };
    next();
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { transactions } from '../../db/schema/transactions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { authMiddleware } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { getUserPayments } from '../payment.controller';

interface JsonResponse {
  status: number;
  /** The `sendSuccess` envelope. `data` is deliberately `unknown[]`. */
  body: { data?: unknown[]; message?: string; error?: string };
  /** The raw text, so key PRESENCE can be asserted, not just values. */
  raw: string;
}

let server: http.Server;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertTransaction(
  values: Omit<typeof transactions.$inferInsert, 'userId'> & { userId: string }
): Promise<string> {
  const [row] = await getDb().insert(transactions).values(values).returning({ id: transactions.id });
  return row.id;
}

async function fetchPayments(): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/payments/user`);
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {}, raw };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.get('/payments/user', authMiddleware, asyncHandler(getUserPayments));
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

beforeEach(async () => {
  currentUserId = await insertUser();
});

// Deliberately NO cleanup. Every assertion is scoped to ids this file just
// minted, so deleting them buys nothing — and it would cost something: the
// throwaway database is shared with the whole run, and other suites take global
// counts whose strict comparisons a concurrent DELETE can move DOWN between two
// reads. The rows go away with the database at the end of the run.

describe('GET /payments/user', () => {
  it('emits `amount` as a JSON number, not the `numeric` string postgres.js returns', async () => {
    await insertTransaction({
      userId: currentUserId,
      type: 'purchase',
      amount: '25.5',
      status: 'completed',
    });

    const res = await fetchPayments();
    expect(res.status).toBe(200);
    const [payment] = res.body.data as [{ amount: unknown }];
    expect(typeof payment.amount).toBe('number');
    expect(payment.amount).toBe(25.5);
    // The emitted JSON carries a bare number — `"amount":"25.5"` would satisfy
    // a value comparison but not this.
    expect(res.raw).toContain('"amount":25.5');
  });

  it('OMITS an absent optional rather than emitting null', async () => {
    const id = await insertTransaction({
      userId: currentUserId,
      type: 'deposit',
      amount: '10',
      status: 'pending',
    });

    const res = await fetchPayments();
    const [payment] = res.body.data as [Record<string, unknown>];
    // The whole key set — `description`, `itemId`, `itemType` and `completedAt`
    // are all unset on this row and must not appear at all.
    expect(Object.keys(payment).sort()).toEqual([
      'amount',
      'id',
      'status',
      'timestamp',
      'type',
      'userId',
    ]);
    expect(payment.id).toBe(id);
    expect(payment.userId).toBe(currentUserId);
    expect(res.raw).not.toContain('null');
  });

  it('emits every optional that IS set', async () => {
    const completedAt = new Date('2026-03-04T05:06:07.000Z');
    await insertTransaction({
      userId: currentUserId,
      type: 'purchase',
      amount: '3.25',
      status: 'completed',
      description: 'A thing',
      itemId: 'item-1',
      itemType: 'sticker',
      completedAt,
    });

    const res = await fetchPayments();
    const [payment] = res.body.data as [Record<string, unknown>];
    expect(payment).toMatchObject({
      type: 'purchase',
      amount: 3.25,
      status: 'completed',
      description: 'A thing',
      itemId: 'item-1',
      itemType: 'sticker',
      completedAt: completedAt.toISOString(),
    });
    // `timestamp` is the row's `created_at` under the name the wire has always
    // used — an ISO-8601 string, never a raw `timestamptz` text form.
    expect(typeof payment.timestamp).toBe('string');
    expect(new Date(String(payment.timestamp)).toISOString()).toBe(String(payment.timestamp));
  });

  it('returns ONLY `deposit` and `purchase` — never a withdrawal or transfer', async () => {
    for (const type of ['deposit', 'withdrawal', 'transfer', 'purchase'] as const) {
      await insertTransaction({ userId: currentUserId, type, amount: '1', status: 'completed' });
    }

    const res = await fetchPayments();
    const types = (res.body.data as { type: string }[]).map((payment) => payment.type).sort();
    expect(types).toEqual(['deposit', 'purchase']);
  });

  it('returns ONLY the caller\'s rows', async () => {
    const stranger = await insertUser();
    await insertTransaction({ userId: stranger, type: 'purchase', amount: '9', status: 'completed' });
    await insertTransaction({
      userId: currentUserId,
      type: 'purchase',
      amount: '4',
      status: 'completed',
    });

    const res = await fetchPayments();
    expect(res.body.data).toHaveLength(1);
    expect((res.body.data as { userId: string }[])[0].userId).toBe(currentUserId);
  });

  it('does NOT return a row where the caller is only the RECIPIENT', async () => {
    const payer = await insertUser();
    await insertTransaction({
      userId: payer,
      recipientId: currentUserId,
      type: 'purchase',
      amount: '7',
      status: 'completed',
    });

    const res = await fetchPayments();
    expect(res.body.data).toEqual([]);
  });

  it('orders newest first', async () => {
    const older = await insertTransaction({
      userId: currentUserId,
      type: 'deposit',
      amount: '1',
      status: 'completed',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await insertTransaction({
      userId: currentUserId,
      type: 'deposit',
      amount: '2',
      status: 'completed',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const res = await fetchPayments();
    expect((res.body.data as { id: string }[]).map((payment) => payment.id)).toEqual([newer, older]);
  });

  it('returns an empty list for an account with no payments', async () => {
    const res = await fetchPayments();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('preserves the full 8-decimal scale of a FairCoin amount', async () => {
    await insertTransaction({
      userId: currentUserId,
      type: 'purchase',
      amount: '0.00000001',
      status: 'completed',
    });

    const res = await fetchPayments();
    expect((res.body.data as { amount: number }[])[0].amount).toBe(0.00000001);
  });
});
