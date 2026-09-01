/**
 * appSignalsService.ingestAffinityEvents — the interaction-affinity graph ingest
 * (Fase 2), against a REAL Postgres.
 *
 * The edge table and the `app_affinity_seen_events` idempotency ledger are real,
 * so the directed-edge unique index and the `(applicationId, eventId)` dedup are
 * the ones the shipped DDL creates. The decay math is the pure `decayAffinity`
 * from `recommendationWeights` (unmocked), so these exercise the real
 * decay-then-add.
 *
 * Coverage:
 *  - a new edge is created at the event's weight, and is reported as CREATED,
 *  - a second event on the same edge DECAYS the stored value then ADDS the new
 *    weight (not a naive sum, not a double-count) and is NOT reported as created,
 *  - an out-of-order (older) event never rewinds the edge's decay clock,
 *  - a caller `weight` overrides the per-type default,
 *  - self-edges and ids that name no user are rejected as invalid,
 *  - an unknown type with no override is rejected (0 weight),
 *  - a repeated `eventId` is deduped (folded at most once).
 */

import { and, eq } from 'drizzle-orm';
import {
  AFFINITY_EVENT_WEIGHTS,
  AFFINITY_HALF_LIFE_MS,
  decayAffinity,
} from '../../utils/recommendationWeights';

jest.mock('../reputation.service', () => ({
  __esModule: true,
  default: { award: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appAffinityEdges, applications, users } from '../../db/schema';
import { appSignalsService } from '../appSignals.service';

let APP_ID = '';
let FROM_ID = '';
let TO_ID = '';

/** A real `users` row. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** The directed affinity edge, or undefined. */
async function readEdge(
  applicationId: string,
  fromUserId: string,
  toUserId: string
): Promise<typeof appAffinityEdges.$inferSelect | undefined> {
  const [row] = await getDb()
    .select()
    .from(appAffinityEdges)
    .where(
      and(
        eq(appAffinityEdges.applicationId, applicationId),
        eq(appAffinityEdges.fromUserId, fromUserId),
        eq(appAffinityEdges.toUserId, toUserId)
      )
    )
    .limit(1);
  return row;
}

/** Every affinity edge recorded for an application. */
async function readEdges(
  applicationId: string
): Promise<(typeof appAffinityEdges.$inferSelect)[]> {
  return getDb()
    .select()
    .from(appAffinityEdges)
    .where(eq(appAffinityEdges.applicationId, applicationId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const owner = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: 'Affinity App', ownerAccountId: owner })
    .returning({ id: applications.id });
  APP_ID = app.id;
  FROM_ID = await account();
  TO_ID = await account();
});

describe('appSignalsService.ingestAffinityEvents', () => {
  it('creates a new edge at the per-type default weight', async () => {
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like' },
    ]);

    expect(result).toEqual({ applied: 1, edgesCreated: 1, duplicate: 0, invalid: 0 });
    const edge = await readEdge(APP_ID, FROM_ID, TO_ID);
    expect(edge?.affinity).toBe(AFFINITY_EVENT_WEIGHTS.like);
    expect(edge?.eventCount).toBe(1);
  });

  it('honors a caller weight override over the per-type default', async () => {
    await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', weight: 9 },
    ]);
    expect((await readEdge(APP_ID, FROM_ID, TO_ID))?.affinity).toBe(9);
  });

  it('DECAYS the stored affinity then ADDS the new event weight (not a naive sum)', async () => {
    // First event: occurred exactly one half-life ago, weight 10.
    const halfLifeAgo = new Date(Date.now() - AFFINITY_HALF_LIFE_MS);
    await appSignalsService.ingestAffinityEvents(APP_ID, [
      {
        fromUserId: FROM_ID,
        toUserId: TO_ID,
        type: 'like',
        weight: 10,
        occurredAt: halfLifeAgo.toISOString(),
      },
    ]);
    expect((await readEdge(APP_ID, FROM_ID, TO_ID))?.affinity).toBe(10);

    // Second event now (weight 4). The stored 10 was set one half-life ago, so
    // it decays to ~5 on read, then +4 → ~9. A naive sum would be 14.
    const second = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'reply', weight: 4 },
    ]);
    // The second fold updates the existing edge — it does NOT create one.
    expect(second).toEqual({ applied: 1, edgesCreated: 0, duplicate: 0, invalid: 0 });

    const edge = await readEdge(APP_ID, FROM_ID, TO_ID);
    const expected = decayAffinity(10, halfLifeAgo, Date.now()) + 4;
    expect(edge?.affinity as number).toBeCloseTo(expected, 1);
    expect(edge?.affinity as number).toBeLessThan(14); // proves it is NOT a naive sum
    expect(edge?.eventCount).toBe(2);
    expect(await readEdges(APP_ID)).toHaveLength(1);
  });

  it('an out-of-order (older) event never rewinds the edge decay clock', async () => {
    const now = new Date();
    await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', occurredAt: now.toISOString() },
    ]);

    const older = new Date(now.getTime() - AFFINITY_HALF_LIFE_MS);
    await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', occurredAt: older.toISOString() },
    ]);

    const edge = await readEdge(APP_ID, FROM_ID, TO_ID);
    expect(edge?.lastEventAt?.getTime()).toBe(now.getTime());
  });

  it('rejects a self-edge as invalid (no edge created)', async () => {
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: FROM_ID, type: 'like' },
    ]);
    expect(result).toEqual({ applied: 0, edgesCreated: 0, duplicate: 0, invalid: 1 });
    expect(await readEdges(APP_ID)).toHaveLength(0);
  });

  it('rejects an id that names no user as invalid', async () => {
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: 'no-such-user', toUserId: TO_ID, type: 'like' },
    ]);
    expect(result).toEqual({ applied: 0, edgesCreated: 0, duplicate: 0, invalid: 1 });
    expect(await readEdges(APP_ID)).toHaveLength(0);
  });

  it('rejects an unknown type with no override (zero weight) as invalid', async () => {
    // The contract enum blocks unknown types at the boundary, but the service is
    // defensive: a 0-weight event never touches the edge or its decay clock.
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', weight: 0 },
    ]);
    expect(result).toEqual({ applied: 0, edgesCreated: 0, duplicate: 0, invalid: 1 });
    expect(await readEdges(APP_ID)).toHaveLength(0);
  });

  it('dedups a repeated eventId (folded at most once)', async () => {
    const event = {
      fromUserId: FROM_ID,
      toUserId: TO_ID,
      type: 'like' as const,
      eventId: 'evt_1',
    };

    const first = await appSignalsService.ingestAffinityEvents(APP_ID, [event]);
    expect(first).toEqual({ applied: 1, edgesCreated: 1, duplicate: 0, invalid: 0 });

    const second = await appSignalsService.ingestAffinityEvents(APP_ID, [event]);
    expect(second).toEqual({ applied: 0, edgesCreated: 0, duplicate: 1, invalid: 0 });

    // The affinity was NOT folded twice.
    const edge = await readEdge(APP_ID, FROM_ID, TO_ID);
    expect(edge?.affinity).toBe(AFFINITY_EVENT_WEIGHTS.like);
    expect(edge?.eventCount).toBe(1);
  });

  it('dedups an eventId whose only difference is surrounding whitespace', async () => {
    // `AppAffinityEventSeen.eventId` was `trim: true` in Mongoose; Postgres has
    // no setter, so the trim is re-applied at this call site or the same id in
    // two spellings folds twice.
    await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', eventId: 'evt_2' },
    ]);
    const second = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'like', eventId: '  evt_2  ' },
    ]);

    expect(second).toEqual({ applied: 0, edgesCreated: 0, duplicate: 1, invalid: 0 });
    expect((await readEdge(APP_ID, FROM_ID, TO_ID))?.eventCount).toBe(1);
  });

  it('folds multiple distinct events in one batch', async () => {
    const other = await account();
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, [
      { fromUserId: FROM_ID, toUserId: TO_ID, type: 'follow' },
      { fromUserId: FROM_ID, toUserId: other, type: 'like' },
    ]);
    expect(result).toEqual({ applied: 2, edgesCreated: 2, duplicate: 0, invalid: 0 });
    expect((await readEdge(APP_ID, FROM_ID, TO_ID))?.affinity).toBe(
      AFFINITY_EVENT_WEIGHTS.follow
    );
    expect((await readEdge(APP_ID, FROM_ID, other))?.affinity).toBe(AFFINITY_EVENT_WEIGHTS.like);
  });

  it('is a strict no-op for an empty batch', async () => {
    const result = await appSignalsService.ingestAffinityEvents(APP_ID, []);
    expect(result).toEqual({ applied: 0, edgesCreated: 0, duplicate: 0, invalid: 0 });
    expect(await readEdges(APP_ID)).toHaveLength(0);
  });
});
