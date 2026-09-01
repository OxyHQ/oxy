/**
 * Expiry sweep — the TTL-index replacement — against a REAL Postgres.
 *
 * Fourteen models relied on a Mongo TTL index, so this mechanism is the one that
 * must not be subtly wrong. Every assertion runs the real `sweepExpiredRows`
 * against the throwaway database, and every row is tagged with a per-test random
 * value so nothing here depends on a table being empty (the suite shares one
 * database, and the sweep is table-wide by design).
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { findUnsupportedExpiryColumns } from '@oxyhq/db/assert';
import { sweepAllExpiredRows, sweepExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';
import { appAffinitySeenEvents } from '../schema/appAffinitySeenEvents';
import { applications } from '../schema/applications';
import { authChallenges } from '../schema/authChallenges';
import { users } from '../schema/users';
import { AFFINITY_EVENT_SEEN_TTL_SECONDS } from '../../utils/recommendationWeights';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A real `applications` row.
 *
 * `app_affinity_seen_events.application_id` used to take any string; it carries
 * a real foreign key now that `applications` has landed, and that is the point
 * of the constraint. Each call mints its own owning account and application, so
 * no assertion here depends on another test's rows.
 */
async function application(): Promise<string> {
  const [owner] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Affinity ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  return row.id;
}

/** `retentionSeconds: 0` — the column IS the deadline. */
const challengeTarget = EXPIRY_SWEEP_TARGETS.find(
  (target) => getTableName(target.table) === 'auth_challenges'
);
/** A retention window measured from a birth column. */
const affinityTarget = EXPIRY_SWEEP_TARGETS.find(
  (target) => getTableName(target.table) === 'app_affinity_seen_events'
);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('sweep registry', () => {
  it('registers both TTL shapes (guards against a vacuous pass)', () => {
    expect(challengeTarget).toBeDefined();
    expect(affinityTarget).toBeDefined();
    expect(challengeTarget?.retentionSeconds).toBe(0);
    expect(affinityTarget?.retentionSeconds).toBe(AFFINITY_EVENT_SEEN_TTL_SECONDS);
  });

  it('has a supporting index on every swept column', async () => {
    // The sweep's predicate is a range scan on this column; without an index
    // it is a sequential scan of the whole table every interval. Mongo's TTL
    // index carried the same obligation.
    const violations = await findUnsupportedExpiryColumns(getDb(), EXPIRY_SWEEP_TARGETS);

    expect(violations).toEqual([]);
  });
});

describe('sweep with a zero retention (deadline column)', () => {
  it('deletes rows past their deadline and leaves live ones', async () => {
    if (!challengeTarget) throw new Error('auth_challenges is not registered for sweeping');

    const publicKey = `key-${randomUUID()}`;
    const expired = `expired-${randomUUID()}`;
    const live = `live-${randomUUID()}`;

    await getDb().insert(authChallenges).values([
      { publicKey, challenge: expired, expiresAt: new Date(Date.now() - 60_000) },
      { publicKey, challenge: live, expiresAt: new Date(Date.now() + 600_000) },
    ]);

    await sweepExpiredRows(getDb(), challengeTarget);

    const remaining = await getDb()
      .select({ challenge: authChallenges.challenge })
      .from(authChallenges)
      .where(eq(authChallenges.publicKey, publicKey));

    expect(remaining.map((row) => row.challenge)).toEqual([live]);
  });

  it('does not delete a row that expires one second from now', async () => {
    if (!challengeTarget) throw new Error('auth_challenges is not registered for sweeping');

    const publicKey = `key-${randomUUID()}`;
    const challenge = `edge-${randomUUID()}`;
    await getDb()
      .insert(authChallenges)
      .values({ publicKey, challenge, expiresAt: new Date(Date.now() + 1_000) });

    await sweepExpiredRows(getDb(), challengeTarget);

    const remaining = await getDb()
      .select({ challenge: authChallenges.challenge })
      .from(authChallenges)
      .where(eq(authChallenges.publicKey, publicKey));

    expect(remaining).toHaveLength(1);
  });
});

describe('sweep with a retention window (birth column)', () => {
  it('deletes only rows older than the retention', async () => {
    if (!affinityTarget) {
      throw new Error('app_affinity_seen_events is not registered for sweeping');
    }

    const applicationId = await application();
    const retentionDays = AFFINITY_EVENT_SEEN_TTL_SECONDS / 86_400;
    const stale = `stale-${randomUUID()}`;
    const fresh = `fresh-${randomUUID()}`;

    await getDb().insert(appAffinitySeenEvents).values([
      {
        applicationId,
        eventId: stale,
        createdAt: new Date(Date.now() - (retentionDays + 1) * DAY_MS),
      },
      {
        applicationId,
        eventId: fresh,
        createdAt: new Date(Date.now() - (retentionDays - 1) * DAY_MS),
      },
    ]);

    await sweepExpiredRows(getDb(), affinityTarget);

    const remaining = await getDb()
      .select({ eventId: appAffinitySeenEvents.eventId })
      .from(appAffinitySeenEvents)
      .where(eq(appAffinitySeenEvents.applicationId, applicationId));

    expect(remaining.map((row) => row.eventId)).toEqual([fresh]);
  });
});

describe('batching', () => {
  it('reports truncated when the batch ceiling is reached, and finishes on a later run', async () => {
    if (!challengeTarget) throw new Error('auth_challenges is not registered for sweeping');

    const publicKey = `key-${randomUUID()}`;
    const expiresAt = new Date(Date.now() - 60_000);
    await getDb()
      .insert(authChallenges)
      .values(
        Array.from({ length: 5 }, () => ({
          publicKey,
          challenge: `bulk-${randomUUID()}`,
          expiresAt,
        }))
      );

    const first = await sweepExpiredRows(getDb(), challengeTarget, {
      batchSize: 2,
      maxBatches: 1,
    });

    expect(first.table).toBe('auth_challenges');
    expect(first.deleted).toBe(2);
    expect(first.truncated).toBe(true);

    // The remainder is not lost — the next run picks it up, exactly as Mongo's
    // TTL monitor drained a backlog across successive passes.
    const second = await sweepExpiredRows(getDb(), challengeTarget, { batchSize: 1000 });
    expect(second.truncated).toBe(false);

    const remaining = await getDb()
      .select({ challenge: authChallenges.challenge })
      .from(authChallenges)
      .where(eq(authChallenges.publicKey, publicKey));

    expect(remaining).toEqual([]);
  });
});

describe('sweepAllExpiredRows', () => {
  it('returns one result per registered target', async () => {
    const results = await sweepAllExpiredRows(getDb(), EXPIRY_SWEEP_TARGETS);

    expect(results.map((result) => result.table)).toEqual(
      EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table))
    );
  });
});
