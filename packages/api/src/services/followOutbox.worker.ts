/**
 * The `follow_events` outbox worker — claim, dispatch, acknowledge.
 *
 * `followCommand.service.ts` writes an event in the SAME transaction as the
 * relationship change it describes, and delivers nothing. This is the other
 * half: the loop that picks those events up.
 *
 * ## What it does NOT decide
 *
 * No delivery policy lives here. The worker claims an event, hands it to the
 * handler registered for its `type`, and acknowledges it. Which of a person's
 * followers get told, what federates where, whether a `follow.removed` caused by
 * an expiry is worth a notification — all of that belongs to the handlers, and
 * through them to the services that will own it. A worker that also decided
 * would be a second place the policy lives.
 *
 * ## The handler set TODAY
 *
 * Every one of the seven event types is registered to an OBSERVING handler: it
 * records the event and the intent a real handler would carry out, and performs
 * no side effect. There is no notification service and no federation delivery
 * wired to the follow graph yet, and a handler that pretended otherwise would be
 * worse than none — it would acknowledge events nothing acted on.
 *
 * That is also why {@link startFollowOutboxWorker} is OFF unless
 * `FOLLOW_OUTBOX_WORKER_ENABLED` says otherwise. An acknowledgement is a claim
 * that the work happened; running observing handlers against production traffic
 * would consume the backlog that the real handlers, when they exist, have to
 * deliver. The WRITE is never gated — events accumulate whether or not anything
 * is reading them, which is the property that makes turning the loop on later a
 * safe operation rather than a lossy one.
 *
 * ## The claim: a lease, not a held lock
 *
 * Several API tasks run this loop, so an event has to be claimed by exactly one
 * of them. Both mechanisms are here, each doing the job it is actually good at:
 *
 *   - `FOR UPDATE SKIP LOCKED`, inside the claiming statement, is what makes two
 *     tasks racing for the same row resolve instantly instead of blocking — the
 *     loser skips to the next claimable event rather than waiting.
 *   - a LEASE (`claimed_at` / `claimed_by`) is what survives the commit. A row
 *     lock lives inside a transaction, so claiming with the lock alone would
 *     mean holding a transaction — and a database connection — open for as long
 *     as the side effect takes, which for a federation delivery is a network
 *     round trip to a server that may be down.
 *
 * A dead task strands nothing: its lease simply stops being renewed, and after
 * {@link FOLLOW_OUTBOX_LEASE_MS} the event is claimable again. The owner check
 * on acknowledgement is the other side of that — a worker whose lease expired
 * mid-flight cannot mark an event that another worker has since taken, because
 * the second worker is the one that will report an outcome for it.
 *
 * Delivery is therefore AT LEAST ONCE, deliberately. `follow_events.event_id` is
 * deterministic and consumer-facing precisely so a redelivery is recognisable;
 * see the schema's docblock.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getEnvBoolean, getEnvNumber } from '../config/env';
import { getDb, type Database } from '../config/postgres';
import {
  FOLLOW_EVENT_TYPES,
  followEvents,
  type FollowEventCause,
  type FollowEventType,
} from '../db/schema/followEvents';
import { logger } from '../utils/logger';

/**
 * Times an event may be dispatched before it is dead-lettered.
 *
 * Bounds a permanently-failing event so it stops consuming the loop, counted in
 * CLAIMS rather than in recorded failures — see `attempts` in the schema for why
 * the two are not the same number. An event whose worker died before recording
 * anything is claimed once beyond this, and that claim writes the dead letter
 * instead of dispatching.
 */
export const FOLLOW_OUTBOX_MAX_ATTEMPTS = 8;

/**
 * How long a claim is honoured before another worker may take the event.
 *
 * It is also the retry backoff, and that is the point: a failed attempt does NOT
 * release its claim, so the lease that protects an in-flight handler is the same
 * mechanism that keeps a failing event from being retried in a tight loop. One
 * timer, one behaviour to reason about, and a permanently-failing event reaches
 * its attempt limit in `MAX_ATTEMPTS × LEASE` rather than in one tick.
 */
export const FOLLOW_OUTBOX_LEASE_MS = 60_000;

/** Events claimed per tick. Small: each is dispatched one at a time. */
const DEFAULT_BATCH_SIZE = 50;

/** How often the loop looks for work. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Characters of a failure kept in `last_error`. Enough to recognise the failure,
 * bounded so a handler with a large error cannot bloat the row it describes.
 */
const MAX_RECORDED_ERROR_LENGTH = 500;

/** Recorded when the attempt limit is reached with no outcome ever written. */
const ATTEMPTS_EXHAUSTED_REASON =
  'Attempt limit reached without a recorded outcome; the worker was interrupted mid-handler.';

/** Recorded for an event whose `type` no handler is registered for. */
const UNKNOWN_TYPE_REASON = 'No handler is registered for this event type.';

/** The columns a handler receives. */
const EVENT_COLUMNS = {
  id: followEvents.id,
  eventId: followEvents.eventId,
  type: followEvents.type,
  cause: followEvents.cause,
  actorUserId: followEvents.actorUserId,
  relationshipId: followEvents.relationshipId,
  targetUri: followEvents.targetUri,
  targetKind: followEvents.targetKind,
  originApplicationId: followEvents.originApplicationId,
  grantId: followEvents.grantId,
  contextApplicationId: followEvents.contextApplicationId,
  payload: followEvents.payload,
  attempts: followEvents.attempts,
} as const;

/**
 * One claimed event, as a handler sees it.
 *
 * Self-contained by construction — `target_uri` and `target_kind` are
 * denormalized onto the event so a handler never has to read a relationship that
 * a `follow.removed` has already deleted.
 */
export interface FollowOutboxEvent {
  /** Row id. Internal; the identity a consumer dedupes on is `eventId`. */
  id: string;
  eventId: string;
  type: FollowEventType;
  cause: FollowEventCause;
  actorUserId: string;
  relationshipId: string;
  targetUri: string;
  targetKind: string;
  originApplicationId: string | null;
  grantId: string | null;
  contextApplicationId: string | null;
  payload: Record<string, unknown> | null;
  /** Claims so far, this one included. 1 on the first delivery. */
  attempts: number;
}

/**
 * What happens to an event of one type.
 *
 * Throwing is how a handler says "not yet" — the event keeps its claim, is
 * retried when the lease expires, and is dead-lettered once the attempts run
 * out. Returning is a promise that the effect HAPPENED, because it is what
 * causes `processed_at` to be written.
 */
export type FollowEventHandler = (event: FollowOutboxEvent) => Promise<void>;

/**
 * Every event type maps to exactly one handler.
 *
 * `Record<FollowEventType, …>` rather than a partial map, so adding a type to
 * `FOLLOW_EVENT_TYPES` without deciding what happens to it is a compile error
 * rather than an event that quietly reaches the dead-letter queue in production.
 */
export type FollowEventHandlerRegistry = Readonly<Record<FollowEventType, FollowEventHandler>>;

/**
 * A handler that performs no side effect and records the one it stands in for.
 *
 * `info`, not `debug`: while this is the whole handler set, the log line IS the
 * output of the phase, and a worker somebody deliberately switched on to watch
 * should not need a log-level change to say anything.
 */
function observing(intent: string): FollowEventHandler {
  return async (event) => {
    await Promise.resolve();
    logger.info('[FollowOutbox] Observed follow event', {
      eventId: event.eventId,
      type: event.type,
      cause: event.cause,
      actorUserId: event.actorUserId,
      relationshipId: event.relationshipId,
      targetKind: event.targetKind,
      intent,
    });
  };
}

/**
 * The handler set. Every entry OBSERVES — see this module's docblock for why
 * none of them delivers anything yet. The intent each carries is what the
 * handler that replaces it will be responsible for.
 */
export const followEventHandlers: FollowEventHandlerRegistry = {
  'follow.created': observing('federate the follow and tell the target they have a new follower'),
  'follow.removed': observing('federate the undo and withdraw any pending notification'),
  'follow.requested': observing('deliver the request to the target for a decision'),
  'follow.accepted': observing('federate the accept and tell the follower they were let in'),
  'follow.rejected': observing('federate the reject; the follower is told nothing else'),
  'follow.context_enabled': observing(
    'reproject the relationship for this application; never notify the target'
  ),
  'follow.context_disabled': observing(
    'reproject the relationship for this application; never notify the target'
  ),
};

export interface FollowOutboxBatchOptions {
  /**
   * Who is claiming. Must be unique per worker INSTANCE, not per process — two
   * loops in one process sharing an id could acknowledge each other's events.
   */
  ownerId: string;
  batchSize?: number;
  handlers?: FollowEventHandlerRegistry;
  /** Overridable so a test can make a claim reclaimable without waiting a minute. */
  leaseMs?: number;
}

export interface FollowOutboxBatchResult {
  claimed: number;
  /** Acknowledged — the handler returned and `processed_at` was written. */
  processed: number;
  /** The handler threw. Retried when the lease expires. */
  failed: number;
  /** Marked `failed_at`: out of attempts, or an event type nothing handles. */
  deadLettered: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

/**
 * The events this worker may take: unprocessed, not dead-lettered, and either
 * never claimed or holding a lease that has run out.
 *
 * A separate function because the claim UPDATE and the test that asserts
 * `follow_events_pending_idx` still serves it must be looking at the SAME query
 * — a test carrying its own copy would keep passing after the real one changed.
 *
 * `FOR UPDATE SKIP LOCKED` makes a race resolve rather than block: two workers
 * reaching the same row in the same instant do not queue behind each other, the
 * loser moves on to the next claimable event.
 *
 * Deliberately NOT filtered on `attempts`: an exhausted event is claimed one
 * final time and dead-lettered instead of dispatched, which is what keeps the
 * bound enforceable from an indexed, LIMITed statement. Excluding it here
 * instead would mean sweeping for exhausted events separately, and that sweep
 * has no bound — it would walk the entire pending backlog on every tick to find
 * the handful of rows it exists for.
 */
export function claimableFollowEvents(db: Database, claimedBefore: Date, limit: number) {
  return db
    .select({ id: followEvents.id })
    .from(followEvents)
    .where(
      and(
        isNull(followEvents.processedAt),
        isNull(followEvents.failedAt),
        or(isNull(followEvents.claimedAt), lt(followEvents.claimedAt, claimedBefore))
      )
    )
    .orderBy(asc(followEvents.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/**
 * Dead-letter an event that ran out of attempts without ever recording an
 * outcome.
 *
 * The failure path below marks its own dead letters as it records them, so this
 * only catches the case it cannot: a worker killed mid-handler, every time.
 * `attempts` is incremented when the claim is taken, so such an event still
 * counts down — but nothing ever writes `failed_at` for it, and without this it
 * would be retried forever, which is precisely what a bound is for.
 *
 * `coalesce` keeps a real error an earlier attempt already recorded; the stated
 * reason is for the row that has none.
 */
async function deadLetterExhausted(db: Database, rowId: string, ownerId: string): Promise<void> {
  await db
    .update(followEvents)
    .set({
      failedAt: new Date(),
      lastError: sql`coalesce(${followEvents.lastError}, ${ATTEMPTS_EXHAUSTED_REASON})`,
    })
    .where(
      and(
        eq(followEvents.id, rowId),
        eq(followEvents.claimedBy, ownerId),
        isNull(followEvents.processedAt)
      )
    );
}

/**
 * Mark an event done — and ONLY here, after its handler returned.
 *
 * The owner check is what makes an expired lease harmless: if another worker
 * took the event while this one was still working, this update matches nothing
 * and the other worker's outcome stands.
 */
async function acknowledge(db: Database, rowId: string, ownerId: string): Promise<boolean> {
  const acknowledged = await db
    .update(followEvents)
    .set({ processedAt: new Date(), lastError: null })
    .where(
      and(
        eq(followEvents.id, rowId),
        eq(followEvents.claimedBy, ownerId),
        isNull(followEvents.processedAt)
      )
    )
    .returning({ id: followEvents.id });

  return acknowledged.length === 1;
}

/**
 * Record a failure. Deliberately does NOT clear the claim: the remaining lease
 * is the backoff before the next attempt.
 */
async function recordFailure(
  db: Database,
  rowId: string,
  ownerId: string,
  reason: string,
  deadLetter: boolean
): Promise<void> {
  await db
    .update(followEvents)
    .set({ lastError: reason, ...(deadLetter ? { failedAt: new Date() } : {}) })
    .where(
      and(
        eq(followEvents.id, rowId),
        eq(followEvents.claimedBy, ownerId),
        isNull(followEvents.processedAt)
      )
    );
}

/**
 * Claim a batch, dispatch each event, acknowledge what succeeded.
 *
 * Exported so a test — and, later, a scheduled job — can run one pass without
 * the interval. Never throws for a single event's failure: one poison event must
 * not stop the batch behind it.
 */
export async function runFollowOutboxBatch(
  options: FollowOutboxBatchOptions
): Promise<FollowOutboxBatchResult> {
  const db = getDb();
  const handlers = options.handlers ?? followEventHandlers;
  const batchSize = options.batchSize ?? getEnvNumber('FOLLOW_OUTBOX_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? FOLLOW_OUTBOX_LEASE_MS;
  const claimedBefore = new Date(Date.now() - leaseMs);

  // ONE statement: the rows are selected, locked and stamped together, so there
  // is no window between deciding to claim and having claimed.
  const claimed = await db
    .update(followEvents)
    .set({
      claimedAt: new Date(),
      claimedBy: options.ownerId,
      attempts: sql`${followEvents.attempts} + 1`,
    })
    .where(inArray(followEvents.id, claimableFollowEvents(db, claimedBefore, batchSize)))
    .returning(EVENT_COLUMNS);

  const result: FollowOutboxBatchResult = {
    claimed: claimed.length,
    processed: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const event of claimed) {
    // Past the bound with nothing ever recorded: every previous claim was
    // interrupted before its handler could report. Dead-lettered WITHOUT being
    // dispatched — this claim exists only to write the marker.
    if (event.attempts > FOLLOW_OUTBOX_MAX_ATTEMPTS) {
      await deadLetterExhausted(db, event.id, options.ownerId);
      result.deadLettered += 1;
      logger.error('[FollowOutbox] Dead-lettered an event that exhausted its attempts', {
        eventId: event.eventId,
        type: event.type,
        attempts: event.attempts,
      });
      continue;
    }

    // A type this build has no handler for. `follow_events_type_check` (0019)
    // keeps an arbitrary value out of the column, but it does not make this
    // unreachable: widening that constraint is one migration, and during the
    // rollout that follows it the previous image is still claiming events —
    // including ones written under a type its own registry has never heard of.
    // Widened here rather than trusted, and a miss is not retryable: no number
    // of attempts makes a handler appear.
    const registry: Readonly<Partial<Record<string, FollowEventHandler>>> = handlers;
    const handler = registry[event.type];

    if (!handler) {
      await recordFailure(db, event.id, options.ownerId, UNKNOWN_TYPE_REASON, true);
      result.deadLettered += 1;
      logger.error('[FollowOutbox] Dead-lettered an event no handler is registered for', {
        eventId: event.eventId,
        type: event.type,
        knownTypes: FOLLOW_EVENT_TYPES,
      });
      continue;
    }

    try {
      await handler(event);
    } catch (error) {
      const exhausted = event.attempts >= FOLLOW_OUTBOX_MAX_ATTEMPTS;
      await recordFailure(db, event.id, options.ownerId, describeError(error), exhausted);
      result.failed += 1;
      if (exhausted) result.deadLettered += 1;
      logger.error('[FollowOutbox] Handler failed', error, {
        eventId: event.eventId,
        type: event.type,
        attempts: event.attempts,
        deadLettered: exhausted,
      });
      continue;
    }

    if (await acknowledge(db, event.id, options.ownerId)) {
      result.processed += 1;
    } else {
      // Not an error: the lease expired mid-handler and another worker owns the
      // event now. Worth saying, because it means the handler ran twice.
      logger.warn('[FollowOutbox] Lease was lost before the event could be acknowledged', {
        eventId: event.eventId,
        type: event.type,
      });
    }
  }

  return result;
}

/**
 * This worker instance.
 *
 * Host and pid make it readable in a `claimed_by` an operator is looking at;
 * the random suffix is what keeps it unique across a pid the kernel reused.
 */
const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  // A tick that overruns its interval must not stack on itself: a second pass
  // would claim the next batch while the first is still dispatching, which turns
  // a slow handler into unbounded concurrency.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runFollowOutboxBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    // Reaching here means the CLAIM failed — the database is unreachable, or the
    // statement is wrong. Never rethrown: an unhandled rejection out of an
    // interval takes the process down, and the next tick retries anyway.
    logger.error(
      '[FollowOutbox] Batch failed',
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start the loop, if this deployment says to.
 *
 * OFF by default — see this module's docblock. Idempotent, and never throws:
 * boot must not depend on it.
 *
 * @returns Whether the loop is now running.
 */
export function startFollowOutboxWorker(): boolean {
  if (!getEnvBoolean('FOLLOW_OUTBOX_WORKER_ENABLED', false)) {
    logger.info(
      '[FollowOutbox] Worker disabled (FOLLOW_OUTBOX_WORKER_ENABLED) — follow events accumulate for whenever it is enabled'
    );
    return false;
  }

  if (timer) return true;

  const intervalMs = Math.max(
    getEnvNumber('FOLLOW_OUTBOX_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100
  );
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never keeps the process alive on its own — in jest an interval that does
  // hangs the whole run.
  timer.unref?.();
  void tick();

  logger.info('[FollowOutbox] Worker started', { ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

/** Stop the loop. Safe to call when it never started. */
export function stopFollowOutboxWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('[FollowOutbox] Worker stopped', { ownerId: WORKER_OWNER_ID });
}
