/**
 * The `oxy` profile colour is a PAID entitlement, against a real Postgres.
 *
 * The suite this replaces asserted `expect(set).toHaveBeenCalledWith('color',
 * 'blue')` on a mocked Mongoose document, and stubbed
 * `resolveUserSubscriptionPlan` to return `'basic'`. It therefore proved
 * nothing about the gate: the plan resolver never ran, and "the write was
 * attempted" is not "the value was stored".
 *
 * The gate's whole design is that the premium check reads the SAME canonical
 * value the write persists (`trim` + `lowercase`), so ` oxy ` / `OXY` cannot
 * slip past a check on the raw input and then land as the gated preset. That
 * bypass is only observable by reading the row back, which is what every case
 * below does — a rejected write must leave the STORED colour untouched, not
 * merely throw.
 *
 * Entitlement comes from real `billing_subscriptions` / `subscriptions` rows
 * through the production resolver, so a change to what counts as premium fails
 * here rather than passing against a stub.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, color: 'blue', ...overrides });
  return id;
}

/** The colour actually stored for `userId`. */
async function storedColor(userId: string): Promise<string> {
  const [row] = await getDb()
    .select({ color: users.color })
    .from(users)
    .where(eq(users.id, userId));
  return row.color;
}

/** A live Stripe subscription on `planName` — the production premium source. */
async function giveSubscription(userId: string, planName: string): Promise<void> {
  const now = new Date();
  await getDb().insert(billingSubscriptions).values({
    userId,
    stripeCustomerId: `cus_${uniqueId()}`,
    stripeSubscriptionId: `sub_${uniqueId()}`,
    stripePriceId: `price_${uniqueId()}`,
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    planName,
    planCreditsPerMonth: 1000,
    planPriceMinorUnits: 900,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('an ungated colour', () => {
  it('is stored trimmed and lower-cased', async () => {
    const id = await makeUser();

    const updated = await userService.updateUserProfile(id, { color: ' Blue ' });

    expect(updated.color).toBe('blue');
    expect(await storedColor(id)).toBe('blue');
  });

  it('needs no subscription lookup at all', async () => {
    // A user with no subscription row of any kind can still set a normal colour.
    const id = await makeUser();
    await userService.updateUserProfile(id, { color: 'red' });
    expect(await storedColor(id)).toBe('red');
  });
});

describe('the `oxy` colour is refused without premium', () => {
  // Every spelling that NORMALIZES to the gated value. The check runs on the
  // canonical form precisely so these cannot differ from plain `oxy`; a gate
  // reading the raw input would let all four through and then store `oxy`.
  it.each([['oxy'], ['OXY'], ['OxY'], [' oxy ']])(
    'rejects %p and leaves the stored colour unchanged',
    async (color) => {
      const id = await makeUser({ color: 'blue' });

      // The CLASS and the message are asserted separately because they fail
      // separately: `toThrow(message)` passes for any error carrying that text,
      // so it says nothing about the status. A bare `Error` reaches
      // `errorHandler`'s catch-all and answers 500 with "An unexpected error
      // occurred" in production — the user is told the server broke, and never
      // told why their colour did not save. The refused write is a no-op (the
      // assertion below is exactly that), so asking twice costs nothing.
      await expect(userService.updateUserProfile(id, { color })).rejects.toThrow(BadRequestError);
      await expect(userService.updateUserProfile(id, { color })).rejects.toThrow(
        'The oxy color is exclusive to premium subscribers'
      );

      // The load-bearing half: the write did not happen. A gate that throws
      // AFTER persisting would pass a rejects-only assertion.
      expect(await storedColor(id)).toBe('blue');
    }
  );

  it('rejects it for a subscriber on the free tier', async () => {
    const id = await makeUser();
    await giveSubscription(id, 'basic');

    await expect(userService.updateUserProfile(id, { color: 'oxy' })).rejects.toThrow(
      'The oxy color is exclusive to premium subscribers'
    );
    expect(await storedColor(id)).toBe('blue');
  });

  it('rejects it for a subscription that is no longer live', async () => {
    const id = await makeUser();
    const now = new Date();
    await getDb().insert(billingSubscriptions).values({
      userId: id,
      stripeCustomerId: `cus_${uniqueId()}`,
      stripeSubscriptionId: `sub_${uniqueId()}`,
      stripePriceId: `price_${uniqueId()}`,
      status: 'canceled',
      currentPeriodStart: now,
      currentPeriodEnd: now,
      planName: 'pro',
      planCreditsPerMonth: 1000,
      planPriceMinorUnits: 900,
    });

    await expect(userService.updateUserProfile(id, { color: 'oxy' })).rejects.toThrow(
      'The oxy color is exclusive to premium subscribers'
    );
    expect(await storedColor(id)).toBe('blue');
  });
});

describe('the `oxy` colour is granted where it is earned', () => {
  it.each([['pro'], ['business']])('allows a live %p subscriber', async (plan) => {
    const id = await makeUser();
    await giveSubscription(id, plan);

    await userService.updateUserProfile(id, { color: ' OXY ' });

    // Granted AND canonicalized — the same normalization the gate checked.
    expect(await storedColor(id)).toBe('oxy');
  });

  it('allows the `oxy` account itself with no subscription', async () => {
    // The brand account owns the preset; it is identified by username, and the
    // comparison is case-insensitive.
    const id = await makeUser({ username: 'OXY' });

    await userService.updateUserProfile(id, { color: 'oxy' });

    expect(await storedColor(id)).toBe('oxy');
  });

  it('does not extend that exemption to a merely oxy-ish username', async () => {
    const id = await makeUser({ username: `oxy${uniqueId().slice(0, 8)}` });

    await expect(userService.updateUserProfile(id, { color: 'oxy' })).rejects.toThrow(
      'The oxy color is exclusive to premium subscribers'
    );
    expect(await storedColor(id)).toBe('blue');
  });
});
