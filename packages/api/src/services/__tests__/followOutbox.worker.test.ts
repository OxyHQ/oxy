/**
 * The outbox worker's guarantees, against a real Postgres.
 *
 * Every interesting case here is about something that must NOT happen: two
 * workers must not both act on one event, an event whose handler threw must not
 * be marked done, and a permanently-failing event must not be retried forever.
 * None of those is observable without real row locking, so this suite runs
 * against the throwaway database `jest.globalSetup.ts` creates rather than
 * against a mock — a mocked `db` would agree with whatever the worker did.
 *
 * ## Why nothing here asserts a batch's totals
 *
 * `jest.globalSetup.ts` provisions one database per WORKER, not per file, and
 * jest runs several files in each worker one after another. So any file that ran
 * before this one in the same worker — `followCommand.service.test.ts` writes an
 * event per follow — has left pending events in this database, and the worker
 * under test claims whatever is pending. A `claimed`/`processed` count is
 * therefore not this file's to predict.
 *
 * Every assertion is instead scoped to rows this test created: what the handler
 * saw for THOSE events, and what the database holds for THOSE rows afterwards.
 * The properties under test are per-event anyway, which is what makes the
 * scoping honest rather than a workaround.
 */

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { FOLLOW_EVENT_TYPES, followEvents } from '../../db/schema/followEvents';
import { followTargets } from '../../db/schema/followTargets';
import { users } from '../../db/schema/users';
import type { FollowCapability } from '../followCapability.service';
import { followTarget } from '../followCommand.service';
import {
  claimableFollowEvents,
  FOLLOW_OUTBOX_MAX_ATTEMPTS,
  followEventHandlers,
  runFollowOutboxBatch,
  type FollowEventHandler,
  type FollowEventHandlerRegistry,
} from '../followOutbox.worker';

/** Big enough that a batch drains everything pending, this file's rows included. */
const DRAIN_BATCH = 500;

let followerId: string;
let appId: string;
let counter = 0;

const unique = (prefix: string) => `${prefix}${(counter += 1)}`;

/** A registry whose every entry is the same handler — the unit under test. */
function registryOf(handler: FollowEventHandler): FollowEventHandlerRegistry {
  return {
    'follow.created': handler,
    'follow.removed': handler,
    'follow.requested': handler,
    'follow.accepted': handler,
    'follow.rejected': handler,
    'follow.context_enabled': handler,
    'follow.context_disabled': handler,
  };
}

/**
 * Apply `handler` to this test's own events and nothing else.
 *
 * Another test file's events land in the same batch; they must be acknowledged
 * normally rather than dragged into whatever this test is doing.
 */
function scopedTo(eventIds: Set<string>, handler: FollowEventHandler): FollowEventHandlerRegistry {
  return registryOf(async (event) => {
    if (eventIds.has(event.eventId)) await handler(event);
  });
}

function capability(): FollowCapability {
  return {
    userId: followerId,
    applicationId: appId,
    grantId: null as unknown as string,
    scopes: ['follows:read', 'follows:write'],
    sessionId: 'session',
  };
}

/**
 * Create a follow, and hand back the `follow.created` event it wrote.
 *
 * Goes through the command service rather than inserting a row, so the events
 * under test are the ones production actually produces.
 */
async function makeEvent(): Promise<{ rowId: string; eventId: string }> {
  const [followed] = await getDb().insert(users).values({}).returning({ id: users.id });
  const uri = unique('https://oxy.so/users/outbox');
  const [target] = await getDb()
    .insert(followTargets)
    .values({ canonicalUri: uri, kind: 'oxy.user', localUserId: followed.id })
    .returning({ id: followTargets.id });

  const { relationshipId } = await followTarget({
    capability: capability(),
    target: { id: target.id, canonicalUri: uri, kind: 'oxy.user', localUserId: followed.id },
  });

  const [event] = await getDb()
    .select({ rowId: followEvents.id, eventId: followEvents.eventId })
    .from(followEvents)
    .where(eq(followEvents.relationshipId, relationshipId))
    .limit(1);

  return event;
}

async function readEvent(rowId: string) {
  const [row] = await getDb()
    .select({
      processedAt: followEvents.processedAt,
      failedAt: followEvents.failedAt,
      attempts: followEvents.attempts,
      claimedBy: followEvents.claimedBy,
      lastError: followEvents.lastError,
    })
    .from(followEvents)
    .where(eq(followEvents.id, rowId))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const [follower] = await getDb().insert(users).values({}).returning({ id: users.id });
  followerId = follower.id;
  const [app] = await getDb()
    .insert(applications)
    .values({ name: unique('Outbox App '), status: 'active', ownerAccountId: followerId })
    .returning({ id: applications.id });
  appId = app.id;
});

describe('claiming', () => {
  it('acknowledges only after the handler returned', async () => {
    const event = await makeEvent();
    // Captured rather than asserted inside the handler: an expectation that
    // throws in there is caught by the worker and recorded as a handler
    // failure, which would leave the test asserting on the wrong thing.
    let processedAtMidFlight: Date | null | undefined;

    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        processedAtMidFlight = (await readEvent(event.rowId)).processedAt;
      }),
    });

    expect(processedAtMidFlight).toBeNull();
    const row = await readEvent(event.rowId);
    expect(row.processedAt).not.toBeNull();
    expect(row.claimedBy).toBe('worker-a');
    expect(row.attempts).toBe(1);
  });

  it('leaves an acknowledged event alone on the next pass', async () => {
    const event = await makeEvent();
    await runFollowOutboxBatch({ ownerId: 'worker-a', batchSize: DRAIN_BATCH });

    // `leaseMs: 0` so the lease is NOT what keeps it out of this batch —
    // otherwise a claim query that forgot `processed_at is null` entirely would
    // still pass here, hidden behind the lease it left behind.
    let redispatched = false;
    await runFollowOutboxBatch({
      ownerId: 'worker-b',
      batchSize: DRAIN_BATCH,
      leaseMs: 0,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        redispatched = true;
      }),
    });

    expect(redispatched).toBe(false);
    expect((await readEvent(event.rowId)).attempts).toBe(1);
  });

  it('does not re-claim an event whose lease is still live', async () => {
    const event = await makeEvent();

    // Claim it and leave no outcome, exactly as a killed worker would: the
    // claim is committed, the acknowledgement never is.
    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        throw new Error('interrupted');
      }),
    });

    let redispatched = false;
    await runFollowOutboxBatch({
      ownerId: 'worker-b',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        redispatched = true;
      }),
    });

    expect(redispatched).toBe(false);
    const row = await readEvent(event.rowId);
    expect(row.claimedBy).toBe('worker-a');
    expect(row.attempts).toBe(1);
    expect(row.processedAt).toBeNull();
  });

  it('lets another worker take over once the lease has run out', async () => {
    const event = await makeEvent();

    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        throw new Error('interrupted');
      }),
    });

    // `leaseMs: 0` is a dead worker's claim seen from far enough in the future.
    await runFollowOutboxBatch({ ownerId: 'worker-b', batchSize: DRAIN_BATCH, leaseMs: 0 });

    const row = await readEvent(event.rowId);
    expect(row.claimedBy).toBe('worker-b');
    expect(row.processedAt).not.toBeNull();
    expect(row.attempts).toBe(2);
  });
});

describe('two workers running at once', () => {
  it('never hands one event to both', async () => {
    // Two pending events and `batchSize: 1` apiece, so a batch can only take
    // part of what is available — with a batch big enough for everything the
    // first claim to execute wins the lot and there is no race left to observe.
    const mine = [await makeEvent(), await makeEvent()];

    // Both handlers block until two dispatches are in flight, so the two claims
    // provably overlap rather than running one after the other. Recording is
    // NOT scoped to this test's events: a duplicate dispatch of anybody's event
    // is the failure this is looking for.
    let inFlight = 0;
    let release = (): void => {};
    const overlapping = new Promise<void>((resolve) => {
      release = resolve;
    });

    const dispatched: string[] = [];
    const handlers = registryOf(async (event) => {
      dispatched.push(event.eventId);
      inFlight += 1;
      if (inFlight >= 2) release();
      // Bounded, so a worker that claimed nothing cannot hang the run — it
      // surfaces as the `claimed` expectation below instead.
      await Promise.race([
        overlapping,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    });

    const [a, b] = await Promise.all([
      runFollowOutboxBatch({ ownerId: 'worker-a', batchSize: 1, handlers }),
      runFollowOutboxBatch({ ownerId: 'worker-b', batchSize: 1, handlers }),
    ]);

    // Both workers found work — without this the no-duplicates assertion below
    // would pass vacuously on a batch that claimed nothing.
    expect(a.claimed).toBe(1);
    expect(b.claimed).toBe(1);

    // The property: two claims, two DIFFERENT events.
    expect(dispatched).toHaveLength(2);
    expect(new Set(dispatched).size).toBe(2);

    // …and the same thing read back from the database, which is where a double
    // claim would leave its mark whatever the handlers saw.
    for (const event of mine) {
      const row = await readEvent(event.rowId);
      expect(row.attempts).toBeLessThanOrEqual(1);
    }
  });

  it('refuses an acknowledgement from a worker that lost the lease', async () => {
    const event = await makeEvent();

    // A slow worker: while its handler runs, a second worker takes the event
    // over — which is what an expired lease looks like from the inside.
    const result = await runFollowOutboxBatch({
      ownerId: 'worker-slow',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        await runFollowOutboxBatch({ ownerId: 'worker-fast', batchSize: DRAIN_BATCH, leaseMs: 0 });
      }),
    });

    // The slow worker's handler returned, but its acknowledgement matched
    // nothing — the event belongs to the worker that took it over.
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    const row = await readEvent(event.rowId);
    expect(row.claimedBy).toBe('worker-fast');
    expect(row.processedAt).not.toBeNull();
  });
});

describe('failure', () => {
  it('leaves processedAt null when the handler throws', async () => {
    const event = await makeEvent();

    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        throw new Error('delivery refused');
      }),
    });

    const row = await readEvent(event.rowId);
    expect(row.processedAt).toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.lastError).toBe('delivery refused');
  });

  it('retries, then stops at the attempt limit and says why', async () => {
    const event = await makeEvent();
    let dispatches = 0;

    // `leaseMs: 0` collapses the backoff so the bound can be observed without
    // waiting `MAX_ATTEMPTS × LEASE`. It changes when a retry happens, never
    // how many are permitted.
    for (let pass = 0; pass < FOLLOW_OUTBOX_MAX_ATTEMPTS + 3; pass += 1) {
      await runFollowOutboxBatch({
        ownerId: `worker-${pass}`,
        batchSize: DRAIN_BATCH,
        leaseMs: 0,
        handlers: scopedTo(new Set([event.eventId]), async () => {
          dispatches += 1;
          throw new Error('upstream is down');
        }),
      });
    }

    expect(dispatches).toBe(FOLLOW_OUTBOX_MAX_ATTEMPTS);

    const row = await readEvent(event.rowId);
    expect(row.attempts).toBe(FOLLOW_OUTBOX_MAX_ATTEMPTS);
    expect(row.failedAt).not.toBeNull();
    expect(row.lastError).toBe('upstream is down');
    // Dead-lettered, never acknowledged: the effect did not happen, and a queue
    // that marked it done would be hiding that.
    expect(row.processedAt).toBeNull();
  });

  it('one failing event does not stop the ones behind it', async () => {
    const poison = await makeEvent();
    const healthy = await makeEvent();

    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: scopedTo(new Set([poison.eventId]), async () => {
        throw new Error('poison');
      }),
    });

    expect((await readEvent(healthy.rowId)).processedAt).not.toBeNull();
    expect((await readEvent(poison.rowId)).processedAt).toBeNull();
  });

  it('dead-letters an event whose worker keeps dying before it can record anything', async () => {
    const event = await makeEvent();

    // Claims with no outcome — a worker killed mid-handler every time. Nothing
    // ever writes `last_error`, so only the attempt count bounds it.
    await getDb()
      .update(followEvents)
      .set({ attempts: FOLLOW_OUTBOX_MAX_ATTEMPTS })
      .where(eq(followEvents.id, event.rowId));

    let redispatched = false;
    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      leaseMs: 0,
      handlers: scopedTo(new Set([event.eventId]), async () => {
        redispatched = true;
      }),
    });

    // Claimed one last time — that claim is how the marker gets written — but
    // never handed to a handler.
    expect(redispatched).toBe(false);
    const row = await readEvent(event.rowId);
    expect(row.attempts).toBe(FOLLOW_OUTBOX_MAX_ATTEMPTS + 1);
    expect(row.failedAt).not.toBeNull();
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toContain('Attempt limit reached');
  });

  it('dead-letters an event type its registry does not cover, without retrying it', async () => {
    const event = await makeEvent();

    // An earlier version of this wrote a made-up `type` straight into the row.
    // `follow_events_type_check` (0019) refuses that now, which is the whole
    // point of the constraint — so do not restore it.
    //
    // The reachable shape is the other one, and it is the one that matters: a
    // registry that does not cover a type the column legitimately holds. That
    // is every rolling deploy after the constraint is widened, when the
    // previous image keeps claiming events written under a type it has never
    // heard of.
    const incomplete: Record<string, FollowEventHandler> = { ...followEventHandlers };
    delete incomplete['follow.created'];

    await runFollowOutboxBatch({
      ownerId: 'worker-a',
      batchSize: DRAIN_BATCH,
      handlers: incomplete,
    });

    const row = await readEvent(event.rowId);
    expect(row.failedAt).not.toBeNull();
    expect(row.processedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('No handler is registered');
  });
});

describe('the handler registry', () => {
  it('covers every event type the schema can write, and nothing else', () => {
    // A type added to `FOLLOW_EVENT_TYPES` with no handler is a compile error;
    // this is the runtime half — that the registry carries no extra keys
    // either, so a renamed type leaves a dead entry behind rather than
    // silently matching nothing.
    expect(Object.keys(followEventHandlers).sort()).toEqual([...FOLLOW_EVENT_TYPES].sort());
  });

  it('acknowledges through the shipped handlers, so the loop is exercisable', async () => {
    const event = await makeEvent();

    await runFollowOutboxBatch({ ownerId: 'worker-a', batchSize: DRAIN_BATCH });

    const row = await readEvent(event.rowId);
    expect(row.processedAt).not.toBeNull();
    expect(row.failedAt).toBeNull();
  });
});

describe('the claim query', () => {
  it('is served by follow_events_pending_idx', async () => {
    await makeEvent();

    // EXPLAIN of the REAL claim candidate query — the same builder the claim
    // UPDATE uses, so this cannot pass against a stale copy of the predicate.
    //
    // `enable_seqscan = off` because the throwaway database holds a handful of
    // rows and the planner would rightly scan them. What is under test is
    // whether the partial index is USABLE for this predicate at all, which is a
    // question about the two predicates matching, not about table size.
    const db = getDb();
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute(sql`explain ${claimableFollowEvents(db, new Date(), 50)}`);
      return rows.map((row) => String(Object.values(row)[0])).join('\n');
    });

    expect(plan).toContain('follow_events_pending_idx');
  });

  it('filters on processed_at is null, and locks without blocking', () => {
    // The properties the plan above and the concurrency test depend on,
    // asserted directly so a change that drops either fails here too.
    const { sql: text } = claimableFollowEvents(getDb(), new Date(), 50).toSQL();
    expect(text).toContain('"processed_at" is null');
    expect(text).toContain('"failed_at" is null');
    expect(text).toContain('for update skip locked');
  });
});

describe('the write is never gated on the worker', () => {
  it('accumulates events while nothing is reading them, and drains later', async () => {
    const first = await makeEvent();
    const second = await makeEvent();

    // Written and untouched: no worker has run since they were created.
    for (const event of [first, second]) {
      const row = await readEvent(event.rowId);
      expect(row.attempts).toBe(0);
      expect(row.claimedBy).toBeNull();
      expect(row.processedAt).toBeNull();
    }

    await runFollowOutboxBatch({ ownerId: 'worker-a', batchSize: DRAIN_BATCH });

    for (const event of [first, second]) {
      expect((await readEvent(event.rowId)).processedAt).not.toBeNull();
    }
  });
});
