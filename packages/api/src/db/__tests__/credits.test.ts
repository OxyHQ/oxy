/**
 * Credit balance mutations — against a REAL Postgres, including a real race.
 *
 * `db/credits.ts` exists because two of the Mongoose instance methods it
 * replaces were OPTIMISTIC-CONCURRENCY updates, not plain writes. A port that
 * reads the row, decides in JavaScript, and then writes would pass every
 * single-threaded test in this file and still be wrong — so the deduction race
 * below is the assertion that actually holds the mechanism up. It runs genuinely
 * concurrent statements through the application pool and pins BOTH the number
 * that succeeded and the balance they left behind.
 *
 * The whole run shares one database, so every test mints its own account.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { addCredits, deductCredits, refreshCreditsIfNeeded } from '../credits';
import { userCredits } from '../schema/userCredits';
import { users } from '../schema/users';

const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An account with a credit row in a known state. */
async function account(values: {
  creditsFree?: number;
  creditsFreeLimit?: number;
  creditsPaid?: number;
  creditsLastRefresh?: Date;
}): Promise<string> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  await getDb().insert(userCredits).values({ userId: user.id, ...values });
  return user.id;
}

/** The stored balance, as two plain numbers. */
async function balance(userId: string): Promise<{ free: number; paid: number }> {
  const [row] = await getDb().select().from(userCredits).where(eq(userCredits.userId, userId));
  return { free: row.creditsFree, paid: row.creditsPaid };
}

describe('deductCredits', () => {
  it('spends the paid balance before the free one', async () => {
    const userId = await account({ creditsFree: 100, creditsPaid: 50 });

    expect(await deductCredits(getDb(), userId, 30)).toBe(true);
    expect(await balance(userId)).toEqual({ free: 100, paid: 20 });
  });

  it('drains paid first and takes the remainder from free', async () => {
    const userId = await account({ creditsFree: 100, creditsPaid: 50 });

    expect(await deductCredits(getDb(), userId, 70)).toBe(true);
    expect(await balance(userId)).toEqual({ free: 80, paid: 0 });
  });

  it('spends NOTHING when the total is short', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 5 });

    expect(await deductCredits(getDb(), userId, 16)).toBe(false);
    // The guard is part of the same statement, so a refusal cannot have
    // partially applied — which is the failure a read-then-write port produces.
    expect(await balance(userId)).toEqual({ free: 10, paid: 5 });
  });

  it('spends the balance down to exactly zero', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 5 });

    expect(await deductCredits(getDb(), userId, 15)).toBe(true);
    expect(await balance(userId)).toEqual({ free: 0, paid: 0 });
    expect(await deductCredits(getDb(), userId, 1)).toBe(false);
  });

  it('does not let racing deductions spend past the balance', async () => {
    const userId = await account({ creditsFree: 100, creditsPaid: 0 });

    // Ten genuinely concurrent spends of 30 against a balance of 100. Each runs
    // on its own pooled connection, so they contend for the row for real.
    //
    // A read-modify-write port passes every test above and fails HERE: all ten
    // would read 100, all ten would decide they could afford 30, and the balance
    // would land at -200 (or, with the CHECK in place, blow up mid-flight).
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => deductCredits(getDb(), userId, 30))
    );

    expect(outcomes.filter(Boolean)).toHaveLength(3);
    expect(await balance(userId)).toEqual({ free: 10, paid: 0 });
  });

  it('keeps the split correct when racing across both balances', async () => {
    const userId = await account({ creditsFree: 40, creditsPaid: 20 });

    // 60 available, four spends of 25: exactly two can succeed, and paid must be
    // drained before free regardless of which order they land in.
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => deductCredits(getDb(), userId, 25))
    );

    expect(outcomes.filter(Boolean)).toHaveLength(2);
    expect(await balance(userId)).toEqual({ free: 10, paid: 0 });
  });

  it('refuses a negative amount instead of turning a spend into a grant', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 10 });

    // The Mongoose version passed all three of its own checks on `-100` and
    // ADDED 100 paid credits.
    expect(await deductCredits(getDb(), userId, -100)).toBe(false);
    expect(await balance(userId)).toEqual({ free: 10, paid: 10 });
  });

  it('refuses a fractional amount instead of rounding it up', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 0 });

    // Without the guard this depends on how the driver typed the parameter, not
    // on any contract: bound as text Postgres REJECTS it outright, bound as
    // numeric it rounds 1.5 up to 2 and charges more than was asked. Neither is
    // an answer to give a caller about money.
    expect(await deductCredits(getDb(), userId, 1.5)).toBe(false);
    expect(await balance(userId)).toEqual({ free: 10, paid: 0 });
  });

  it('answers false for an account with no credit row', async () => {
    const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    expect(await deductCredits(getDb(), user.id, 1)).toBe(false);
  });
});

describe('refreshCreditsIfNeeded', () => {
  it('restores the free balance to its limit once the interval has passed', async () => {
    const userId = await account({
      creditsFree: 12,
      creditsFreeLimit: 1000,
      creditsPaid: 7,
      creditsLastRefresh: new Date(Date.now() - 25 * HOUR_MS),
    });

    expect(await refreshCreditsIfNeeded(getDb(), userId)).toBe(true);
    // A RESET to the limit, not an increment — and the paid balance is untouched.
    expect(await balance(userId)).toEqual({ free: 1000, paid: 7 });

    const [row] = await getDb().select().from(userCredits).where(eq(userCredits.userId, userId));
    expect(row.creditsLastRefresh.getTime()).toBeGreaterThan(Date.now() - HOUR_MS);
  });

  it('does nothing before the interval has passed', async () => {
    const lastRefresh = new Date(Date.now() - 23 * HOUR_MS);
    const userId = await account({ creditsFree: 12, creditsFreeLimit: 1000, creditsLastRefresh: lastRefresh });

    expect(await refreshCreditsIfNeeded(getDb(), userId)).toBe(false);
    expect(await balance(userId)).toEqual({ free: 12, paid: 0 });

    const [row] = await getDb().select().from(userCredits).where(eq(userCredits.userId, userId));
    expect(row.creditsLastRefresh.getTime()).toBe(lastRefresh.getTime());
  });

  it('does not refresh twice in a row', async () => {
    const userId = await account({
      creditsFree: 0,
      creditsFreeLimit: 1000,
      creditsLastRefresh: new Date(Date.now() - 25 * HOUR_MS),
    });

    expect(await refreshCreditsIfNeeded(getDb(), userId)).toBe(true);
    expect(await refreshCreditsIfNeeded(getDb(), userId)).toBe(false);
  });

  it('does not let racing callers both refresh', async () => {
    const userId = await account({
      creditsFree: 0,
      creditsFreeLimit: 1000,
      creditsLastRefresh: new Date(Date.now() - 25 * HOUR_MS),
    });

    // The elapsed-time test IS the guard, so the loser re-evaluates it against
    // the already-advanced `credits_last_refresh` and matches nothing. Under the
    // Mongoose compare-and-set this held too; under a read-then-write port both
    // callers would refresh and one interval's worth of credits would be granted
    // twice.
    const outcomes = await Promise.all([
      refreshCreditsIfNeeded(getDb(), userId),
      refreshCreditsIfNeeded(getDb(), userId),
      refreshCreditsIfNeeded(getDb(), userId),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await balance(userId)).toEqual({ free: 1000, paid: 0 });
  });

  it('answers false for an account with no credit row', async () => {
    const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
    expect(await refreshCreditsIfNeeded(getDb(), user.id)).toBe(false);
  });
});

describe('addCredits', () => {
  it('grants into the paid balance', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 5 });

    expect(await addCredits(getDb(), userId, 10_000, 'paid')).toBe(true);
    expect(await balance(userId)).toEqual({ free: 10, paid: 10_005 });
  });

  it('grants into the free balance', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 5 });

    expect(await addCredits(getDb(), userId, 40, 'free')).toBe(true);
    expect(await balance(userId)).toEqual({ free: 50, paid: 5 });
  });

  it('accumulates correctly under concurrency', async () => {
    const userId = await account({ creditsFree: 0, creditsPaid: 0 });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => addCredits(getDb(), userId, 100, 'paid'))
    );

    // An increment is already atomic under the row lock; this is what proves it
    // was ported as one rather than as a read-then-write.
    expect(outcomes.filter(Boolean)).toHaveLength(10);
    expect(await balance(userId)).toEqual({ free: 0, paid: 1000 });
  });

  it('refuses a negative amount instead of making it a silent deduction', async () => {
    const userId = await account({ creditsFree: 10, creditsPaid: 10 });

    expect(await addCredits(getDb(), userId, -5, 'paid')).toBe(false);
    expect(await balance(userId)).toEqual({ free: 10, paid: 10 });
  });
});
