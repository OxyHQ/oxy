/**
 * Wallet spend paths — against a REAL Postgres, including real races.
 *
 * Every spend path used to read the balance, compare it in JavaScript, and write
 * the difference back. That passes any single-threaded test and still lets two
 * concurrent spends both succeed, so the concurrency cases below are the ones
 * that actually hold the mechanism up: the guard now lives in the `WHERE` clause
 * of the debit, and the result of the statement is the answer.
 *
 * `wallets.balance` is `numeric(38, 8)` and reads back as a STRING. The assertions
 * compare against the exact decimal text, never a parsed double — a test that
 * did `Number(balance)` would agree with a port that had reintroduced float
 * arithmetic, which is precisely what the column type exists to prevent.
 */

import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { transactions } from '../../db/schema/transactions';
import { users } from '../../db/schema/users';
import { wallets } from '../../db/schema/wallets';
import type { AuthRequest } from '../../middleware/auth';
import { BadRequestError } from '../../utils/error';
import { processPurchase, requestWithdrawal, transferFunds } from '../wallet.controller';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An account with a funded wallet. The whole run shares one database. */
async function fundedAccount(balance: string): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  await getDb().insert(wallets).values({ userId: user.id, balance });
  return user.id;
}

/** The stored balance, as the exact decimal string Postgres holds. */
async function balanceOf(userId: string): Promise<string> {
  const [row] = await getDb()
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  return row.balance;
}

async function ledgerCount(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return rows.length;
}

function responseSpy() {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  return { json, res: { json, status } as unknown as Response };
}

function requestFor(userId: string, body: Record<string, unknown>): AuthRequest {
  return {
    body,
    user: { _id: { toString: () => userId } },
  } as unknown as AuthRequest;
}

describe('processPurchase', () => {
  it('debits the wallet and records the ledger row', async () => {
    const userId = await fundedAccount('100');

    const { res } = responseSpy();
    await processPurchase(
      requestFor(userId, { userId, amount: 30, itemId: 'item-1', itemType: 'sticker' }),
      res,
    );

    expect(await balanceOf(userId)).toBe('70.00000000');
    expect(await ledgerCount(userId)).toBe(1);
  });

  it('refuses to overdraw and moves NOTHING', async () => {
    const userId = await fundedAccount('10');

    const { res } = responseSpy();
    await expect(
      processPurchase(
        requestFor(userId, { userId, amount: 30, itemId: 'item-1', itemType: 'sticker' }),
        res,
      ),
    ).rejects.toThrow(BadRequestError);

    // The whole handler runs in one transaction, so a refusal cannot have left a
    // ledger row behind either.
    expect(await balanceOf(userId)).toBe('10.00000000');
    expect(await ledgerCount(userId)).toBe(0);
  });

  it('does not let racing purchases spend past the balance', async () => {
    const userId = await fundedAccount('100');

    // Ten concurrent spends of 30 against 100. A read-modify-write port passes
    // both cases above and fails HERE: all ten read 100, all ten decide they can
    // afford 30, and the balance lands at -200.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => {
        const { res } = responseSpy();
        return processPurchase(
          requestFor(userId, { userId, amount: 30, itemId: 'item-1', itemType: 'sticker' }),
          res,
        );
      }),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
    expect(await balanceOf(userId)).toBe('10.00000000');
    expect(await ledgerCount(userId)).toBe(3);
  });

  it('keeps exact decimals that a double could not represent', async () => {
    const userId = await fundedAccount('1');

    // Ten spends of 0.1 against 1. In IEEE-754 this leaves 2.2e-16; in `numeric`
    // it leaves exactly zero, and the eleventh spend must therefore be refused.
    for (let i = 0; i < 10; i += 1) {
      const { res } = responseSpy();
      await processPurchase(
        requestFor(userId, { userId, amount: 0.1, itemId: 'item-1', itemType: 'sticker' }),
        res,
      );
    }

    expect(await balanceOf(userId)).toBe('0.00000000');

    const { res } = responseSpy();
    await expect(
      processPurchase(
        requestFor(userId, { userId, amount: 0.00000001, itemId: 'item-1', itemType: 'sticker' }),
        res,
      ),
    ).rejects.toThrow(BadRequestError);
  });
});

describe('transferFunds', () => {
  it('moves the amount from payer to payee', async () => {
    const fromUserId = await fundedAccount('100');
    const toUserId = await fundedAccount('5');

    const { res } = responseSpy();
    await transferFunds(requestFor(fromUserId, { fromUserId, toUserId, amount: 40 }), res);

    expect(await balanceOf(fromUserId)).toBe('60.00000000');
    expect(await balanceOf(toUserId)).toBe('45.00000000');
  });

  it('credits NOTHING when the payer cannot pay', async () => {
    const fromUserId = await fundedAccount('10');
    const toUserId = await fundedAccount('5');

    const { res } = responseSpy();
    await expect(
      transferFunds(requestFor(fromUserId, { fromUserId, toUserId, amount: 40 }), res),
    ).rejects.toThrow(BadRequestError);

    // Both halves are in one transaction: a refused debit rolls the credit back.
    // Money appearing on the payee's side without leaving the payer's is the
    // failure this guards.
    expect(await balanceOf(fromUserId)).toBe('10.00000000');
    expect(await balanceOf(toUserId)).toBe('5.00000000');
  });

  it('conserves the total under concurrent transfers in both directions', async () => {
    const a = await fundedAccount('100');
    const b = await fundedAccount('100');

    // A→B and B→A at once. The two wallet rows are touched in a deterministic
    // order, so these cannot deadlock on each other; whatever the interleaving,
    // the two balances must still sum to 200.
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => {
        const { res } = responseSpy();
        return transferFunds(requestFor(a, { fromUserId: a, toUserId: b, amount: 30 }), res);
      }),
      ...Array.from({ length: 5 }, () => {
        const { res } = responseSpy();
        return transferFunds(requestFor(b, { fromUserId: b, toUserId: a, amount: 30 }), res);
      }),
    ]);

    // A deadlock would surface as a rejection that is not a BadRequestError.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(BadRequestError);
      }
    }

    const total = Number(await balanceOf(a)) + Number(await balanceOf(b));
    expect(total).toBe(200);
  });
});

describe('requestWithdrawal', () => {
  it('records a pending request and stores the payout address WITHOUT debiting', async () => {
    const userId = await fundedAccount('100');

    const { res } = responseSpy();
    await requestWithdrawal(
      requestFor(userId, { userId, amount: 40, address: 'fc1qexampleaddress' }),
      res,
    );

    // A withdrawal is settled out of band, so the balance is untouched until then.
    expect(await balanceOf(userId)).toBe('100.00000000');

    const [wallet] = await getDb()
      .select({ address: wallets.address })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(wallet.address).toBe('fc1qexampleaddress');

    const [ledger] = await getDb()
      .select({ status: transactions.status, type: transactions.type })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(ledger).toEqual({ status: 'pending', type: 'withdrawal' });
  });

  it('refuses when the funds are not there, and does not store the address', async () => {
    const userId = await fundedAccount('10');

    const { res } = responseSpy();
    await expect(
      requestWithdrawal(
        requestFor(userId, { userId, amount: 40, address: 'fc1qexampleaddress' }),
        res,
      ),
    ).rejects.toThrow(BadRequestError);

    const [wallet] = await getDb()
      .select({ address: wallets.address })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    // The address is only recorded for a request that was actually accepted.
    expect(wallet.address).toBeNull();
    expect(await ledgerCount(userId)).toBe(0);
  });
});
