/**
 * appSignals.service — endorsement and interest ingest, against a REAL Postgres.
 *
 * The edge ledger, the per-app roll-up and the user rows are real, so the
 * idempotency index, the `NULLS NOT DISTINCT` source key and the foreign keys
 * are the ones the shipped DDL creates. Only the reputation service is mocked —
 * awarding is a separate subsystem with its own suite, and what matters here is
 * WHO is awarded and HOW OFTEN.
 *
 * Coverage:
 *  - add is idempotent (re-ingesting the same edge is a no-op),
 *  - remove subtracts exactly the STORED weight (not the owner's current weight),
 *  - a floor-reputation owner contributes the influence FLOOR, not a large boost
 *    and not zero,
 *  - the MEMBER (not the giver) is awarded, exactly once per edge,
 *  - self-endorsement and ids that name no user are rejected,
 *  - an unset `sourceId` is NULL and still collides with itself,
 *  - interest ingest is last-write-wins.
 */

import { and, eq } from 'drizzle-orm';
import { INFLUENCE_MIN } from '../../utils/reputation.constants';

const mockAward = jest.fn();
jest.mock('../reputation.service', () => ({
  __esModule: true,
  default: {
    award: (...args: unknown[]) => mockAward(...args),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appEndorsementEdges, appUserSignals, applications, users } from '../../db/schema';
import { appSignalsService } from '../appSignals.service';

let APP_ID = '';
let OWNER_ID = '';
let MEMBER_ID = '';

/** A real `users` row. `reputationRankWeight` defaults to the influence floor. */
async function account(rankWeight?: number): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values(rankWeight === undefined ? {} : { reputationRankWeight: rankWeight })
    .returning({ id: users.id });
  return row.id;
}

/** The member's per-app roll-up row, or undefined. */
async function readSignal(
  applicationId: string,
  userId: string
): Promise<typeof appUserSignals.$inferSelect | undefined> {
  const [row] = await getDb()
    .select()
    .from(appUserSignals)
    .where(
      and(eq(appUserSignals.applicationId, applicationId), eq(appUserSignals.userId, userId))
    )
    .limit(1);
  return row;
}

/** Every endorsement edge recorded for an application. */
async function readEdges(
  applicationId: string
): Promise<(typeof appEndorsementEdges.$inferSelect)[]> {
  return getDb()
    .select()
    .from(appEndorsementEdges)
    .where(eq(appEndorsementEdges.applicationId, applicationId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockAward.mockResolvedValue({ id: 'txn' });

  OWNER_ID = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: 'Signals App', ownerAccountId: OWNER_ID })
    .returning({ id: applications.id });
  APP_ID = app.id;
  MEMBER_ID = await account();
});

describe('appSignalsService.ingestEndorsements', () => {
  it('adds an edge, increments the member roll-up by the owner weight, and awards the MEMBER once', async () => {
    const giver = await account(2.0);

    const result = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);

    expect(result).toEqual({ added: 1, removed: 0, skipped: 0, invalid: 0 });
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(2.0);

    // The MEMBER is awarded, not the giver. Exactly once.
    expect(mockAward).toHaveBeenCalledTimes(1);
    expect(mockAward.mock.calls[0][0]).toMatchObject({
      userId: MEMBER_ID,
      actionType: 'endorsement_received',
      applicationId: APP_ID,
    });
  });

  it('is idempotent: re-ingesting the same edge is a no-op (skipped, no second award)', async () => {
    const giver = await account(2.0);
    const edge = { ownerId: giver, memberId: MEMBER_ID, op: 'add' as const };

    await appSignalsService.ingestEndorsements(APP_ID, [edge]);
    const second = await appSignalsService.ingestEndorsements(APP_ID, [edge]);

    expect(second).toEqual({ added: 0, removed: 0, skipped: 1, invalid: 0 });
    // Score did NOT double, and only one edge exists.
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(2.0);
    expect(await readEdges(APP_ID)).toHaveLength(1);
    expect(mockAward).toHaveBeenCalledTimes(1);
  });

  it('stores an unset sourceId as NULL, and two unset sources still collide', async () => {
    const giver = await account(1.0);

    await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);
    const edges = await readEdges(APP_ID);
    expect(edges).toHaveLength(1);
    // `''` was Mongo's sentinel for "unset"; the port stores NULL and relies on
    // the index being `NULLS NOT DISTINCT` to keep the idempotency guarantee.
    expect(edges[0].sourceId).toBeNull();

    const second = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);
    expect(second.skipped).toBe(1);
    expect(await readEdges(APP_ID)).toHaveLength(1);
  });

  it('treats a different sourceId as a distinct endorsement', async () => {
    const giver = await account(1.0);

    await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add', sourceId: 'list-1' },
      { ownerId: giver, memberId: MEMBER_ID, op: 'add', sourceId: 'list-2' },
    ]);

    expect(await readEdges(APP_ID)).toHaveLength(2);
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(2.0);
  });

  it('remove subtracts exactly the STORED weight even if the owner reputation changed', async () => {
    const giver = await account(2.0);
    await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);

    // Owner's reputation later changes to 0.5 — the remove must still subtract 2.0.
    await getDb().update(users).set({ reputationRankWeight: 0.5 }).where(eq(users.id, giver));

    const removeResult = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'remove' },
    ]);

    expect(removeResult).toEqual({ added: 0, removed: 1, skipped: 0, invalid: 0 });
    // 2.0 - 2.0, NOT 2.0 - 0.5.
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(0);
    expect(await readEdges(APP_ID)).toHaveLength(0);
  });

  it('remove of a non-existent edge is a no-op (skipped)', async () => {
    const result = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: OWNER_ID, memberId: MEMBER_ID, op: 'remove' },
    ]);
    expect(result).toEqual({ added: 0, removed: 0, skipped: 1, invalid: 0 });
    expect(await readSignal(APP_ID, MEMBER_ID)).toBeUndefined();
  });

  it('a floor-reputation owner contributes the influence FLOOR, not a large boost and not zero', async () => {
    // A brand-new account carries the column's floor default — the branch that
    // recomputed a missing denormalized weight via the reputation service is
    // unrepresentable here, because the column is NOT NULL.
    const giver = await account();

    await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);

    const score = (await readSignal(APP_ID, MEMBER_ID))?.endorsementScore;
    expect(score).toBe(INFLUENCE_MIN);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('rejects self-endorsement and an owner that names no user, applying neither', async () => {
    const result = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: OWNER_ID, memberId: OWNER_ID, op: 'add' }, // self
      { ownerId: 'no-such-user', memberId: MEMBER_ID, op: 'add' }, // unknown owner
    ]);
    expect(result).toEqual({ added: 0, removed: 0, skipped: 0, invalid: 2 });
    expect(await readEdges(APP_ID)).toHaveLength(0);
    expect(mockAward).not.toHaveBeenCalled();
  });

  it('one bad edge does not fail the batch around it', async () => {
    const giver = await account(1.0);
    const result = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: 'no-such-user', memberId: MEMBER_ID, op: 'add' },
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);
    expect(result).toEqual({ added: 1, removed: 0, skipped: 0, invalid: 1 });
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(1.0);
  });

  it('does not fail the batch when the member award throws', async () => {
    const giver = await account(1.0);
    mockAward.mockRejectedValueOnce(new Error('rule disabled'));

    const result = await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);

    // Edge + roll-up still applied despite the award failure.
    expect(result.added).toBe(1);
    expect((await readSignal(APP_ID, MEMBER_ID))?.endorsementScore).toBe(1.0);
  });
});

describe('appSignalsService.ingestInterests', () => {
  it('upserts the interest score (last write wins)', async () => {
    await appSignalsService.ingestInterests(APP_ID, [{ userId: MEMBER_ID, interestScore: 0.3 }]);
    expect((await readSignal(APP_ID, MEMBER_ID))?.interestScore).toBe(0.3);

    await appSignalsService.ingestInterests(APP_ID, [{ userId: MEMBER_ID, interestScore: 0.9 }]);
    expect((await readSignal(APP_ID, MEMBER_ID))?.interestScore).toBe(0.9);
  });

  it('leaves an existing endorsement score untouched when writing interest', async () => {
    const giver = await account(2.0);
    await appSignalsService.ingestEndorsements(APP_ID, [
      { ownerId: giver, memberId: MEMBER_ID, op: 'add' },
    ]);
    await appSignalsService.ingestInterests(APP_ID, [{ userId: MEMBER_ID, interestScore: 0.7 }]);

    const signal = await readSignal(APP_ID, MEMBER_ID);
    expect(signal?.endorsementScore).toBe(2.0);
    expect(signal?.interestScore).toBe(0.7);
  });

  it('rejects a user id that names no user', async () => {
    const result = await appSignalsService.ingestInterests(APP_ID, [
      { userId: 'no-such-user', interestScore: 0.5 },
    ]);
    expect(result).toEqual({ upserted: 0, invalid: 1 });
  });
});
