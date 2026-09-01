/**
 * App-signal ingest service — the single write path for the cross-app
 * recommendation signals reported via `POST /app-signals/ingest`.
 *
 * Two signal kinds:
 *  - ENDORSEMENTS: an owner endorses a member in a consuming app (e.g. adds them
 *    to a list / starter pack). The endorsement is weighted by the OWNER's
 *    reputation-derived ranking weight, summed into the member's per-app
 *    `app_user_signals.endorsement_score`, and awards the MEMBER reputation
 *    (`endorsement_received`). The edge ledger (`app_endorsement_edges`) is the
 *    source of truth so a `remove` subtracts exactly the weight that was added.
 *  - INTERESTS: an app reports how interested a user is in its content, stored as
 *    the latest [0, 1] value on `app_user_signals.interest_score`.
 *
 * Idempotency:
 *  - Endorsement edges are keyed by (applicationId, ownerId, memberId, sourceId);
 *    re-ingesting the same `add` is a no-op (the unique index absorbs it), and the
 *    member award is idempotent on (applicationId, sourceActionId = edge id).
 *  - A `remove` for an edge that does not exist is a no-op.
 *
 * ## What "invalid" means now
 *
 * Under Mongo an id was rejected on its FORMAT (`ObjectId.isValid`), which is
 * gone: a Postgres id is `text` and any string is well-formed. What replaces it
 * is stronger — every id column here carries a real FOREIGN KEY, so an id that
 * names no user (or no application) is refused by the database. Those rejections
 * are counted as `invalid` per item, exactly as a malformed id was, and never
 * fail the surrounding batch.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import {
  appAffinityEdges,
  appAffinitySeenEvents,
  appEndorsementEdges,
  appUserSignals,
  users,
} from '../db/schema';
import reputationService from './reputation.service';
import {
  ENDORSEMENT_RECEIVED_ACTION,
  INFLUENCE_MIN,
} from '../utils/reputation.constants';
import { decayAffinity, affinityEventWeight } from '../utils/recommendationWeights';
import { logger } from '../utils/logger';
import type {
  AppEndorsementInput,
  AppInterestInput,
  AppAffinityEvent,
} from '@oxyhq/contracts';

/** Postgres `foreign_key_violation` — an id that names no row. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Outcome of an endorsement-ingest batch. */
export interface EndorsementIngestResult {
  /** Edges newly created (op add, edge did not exist). */
  added: number;
  /** Edges removed (op remove, edge existed). */
  removed: number;
  /** Edges skipped (already-present add, or remove of a missing edge). */
  skipped: number;
  /** Edges rejected (unknown owner/member, owner === member). */
  invalid: number;
}

/** Outcome of an interest-ingest batch. */
export interface InterestIngestResult {
  /** Interest signals written (upserted). */
  upserted: number;
  /** Interest signals rejected (unknown user). */
  invalid: number;
}

/** Outcome of an interaction-affinity-event ingest batch. */
export interface AffinityIngestResult {
  /** Events successfully folded into an affinity edge. */
  applied: number;
  /** New affinity edges created (a subset of `applied`). */
  edgesCreated: number;
  /** Events skipped as duplicates (repeated `eventId`). */
  duplicate: number;
  /** Events rejected (unknown user, self-edge, or unweighted unknown type). */
  invalid: number;
}

/**
 * Whether a failed write was refused by a foreign key — i.e. an id that names no
 * row. Drizzle wraps the driver error, so the SQLSTATE lives on the `cause`
 * chain; walking it is what stops this from degrading into "some error
 * happened" and swallowing a real fault.
 */
function isForeignKeyViolation(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = Reflect.get(current, 'cause')
  ) {
    if (Reflect.get(current, 'code') === FOREIGN_KEY_VIOLATION) {
      return true;
    }
  }
  return false;
}

class AppSignalsService {
  /**
   * Resolve the ranking weight of an endorsement giver from the denormalized
   * `users.reputation_rank_weight` (kept in sync by `recalculateBalance`).
   *
   * The column is `NOT NULL` with a floor default, so the "denorm field absent →
   * recompute via the reputation service" branch the Mongo version carried
   * cannot happen here and does not travel. A row that is missing entirely
   * resolves to the influence floor, and the edge insert that follows will be
   * refused by the foreign key anyway.
   */
  private async resolveOwnerWeight(ownerId: string): Promise<number> {
    const [owner] = await getDb()
      .select({ reputationRankWeight: users.reputationRankWeight })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    return owner?.reputationRankWeight ?? INFLUENCE_MIN;
  }

  /**
   * Apply a batch of endorsement edges for one application. Each edge is applied
   * independently and idempotently; a single bad edge never fails the batch.
   */
  async ingestEndorsements(
    applicationId: string,
    edges: AppEndorsementInput[]
  ): Promise<EndorsementIngestResult> {
    const result: EndorsementIngestResult = {
      added: 0,
      removed: 0,
      skipped: 0,
      invalid: 0,
    };

    for (const edge of edges) {
      // `AppEndorsementEdge.sourceId` was `trim: true` in Mongoose, which has no
      // Postgres counterpart — re-applied here. Its `default: ''` does not
      // travel: an empty string is a VALUE, and the column's CHECK forbids it.
      // Absent is NULL, and the idempotency index is `NULLS NOT DISTINCT` so two
      // unset sources still collide exactly as Mongo intended.
      const sourceId = edge.sourceId?.trim() || null;

      // A user cannot endorse themselves into the recommendation surface.
      if (edge.ownerId === edge.memberId) {
        result.invalid += 1;
        continue;
      }

      if (edge.op === 'remove') {
        await this.removeEdge(applicationId, edge.ownerId, edge.memberId, sourceId, result);
      } else {
        await this.addEdge(applicationId, edge.ownerId, edge.memberId, sourceId, result);
      }
    }

    return result;
  }

  /** Apply a single `add` edge idempotently. */
  private async addEdge(
    applicationId: string,
    ownerId: string,
    memberId: string,
    sourceId: string | null,
    result: EndorsementIngestResult
  ): Promise<void> {
    const db = getDb();
    const weight = await this.resolveOwnerWeight(ownerId);

    // ONE statement decides whether this is a new endorsement: the idempotency
    // index absorbs a repeat, and an empty `returning` IS the "already applied"
    // answer — no read-then-write, and no lost-race window in which the score
    // and the award could be applied twice.
    let edgeId: string;
    try {
      const [created] = await db
        .insert(appEndorsementEdges)
        .values({ applicationId, ownerId, memberId, sourceId, weight })
        .onConflictDoNothing({
          target: [
            appEndorsementEdges.applicationId,
            appEndorsementEdges.ownerId,
            appEndorsementEdges.memberId,
            appEndorsementEdges.sourceId,
          ],
        })
        .returning({ id: appEndorsementEdges.id });
      if (!created) {
        result.skipped += 1;
        return;
      }
      edgeId = created.id;
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      // An endorsement between ids that name no row cannot be applied. Counted
      // like a malformed id was under Mongo — the batch continues.
      logger.warn('appSignals: endorsement rejected by a foreign key', {
        component: 'appSignals.service',
        applicationId,
        ownerId,
        memberId,
      });
      result.invalid += 1;
      return;
    }

    // Increment the member's per-app roll-up by the applied weight. One upsert:
    // the row is created at this weight or the weight is added to it in place.
    await db
      .insert(appUserSignals)
      .values({
        applicationId,
        userId: memberId,
        endorsementScore: weight,
        lastEndorsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [appUserSignals.applicationId, appUserSignals.userId],
        set: {
          endorsementScore: sql`${appUserSignals.endorsementScore} + ${weight}`,
          lastEndorsedAt: new Date(),
        },
      });

    // Award the MEMBER (not the giver). Idempotent on (applicationId,
    // sourceActionId = edge id), so a retried ingest never double-awards.
    try {
      await reputationService.award({
        userId: memberId,
        actionType: ENDORSEMENT_RECEIVED_ACTION,
        applicationId,
        sourceActionId: edgeId,
        sourceActionType: ENDORSEMENT_RECEIVED_ACTION,
        targetEntityId: edgeId,
        targetEntityType: 'user',
      });
    } catch (error) {
      // A missing/disabled rule must not fail the whole ingest — the edge and
      // roll-up are already applied; surface the award failure for diagnosis.
      logger.warn('appSignals: endorsement_received award failed', {
        component: 'appSignals.service',
        memberId,
        edgeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    result.added += 1;
  }

  /** Apply a single `remove` edge idempotently. */
  private async removeEdge(
    applicationId: string,
    ownerId: string,
    memberId: string,
    sourceId: string | null,
    result: EndorsementIngestResult
  ): Promise<void> {
    const db = getDb();

    // The unique index treats two NULL sources as equal; an ordinary `=` does
    // not, so the "unset source" lookup must be spelled `is null` or the delete
    // silently matches nothing.
    const [removed] = await db
      .delete(appEndorsementEdges)
      .where(
        and(
          eq(appEndorsementEdges.applicationId, applicationId),
          eq(appEndorsementEdges.ownerId, ownerId),
          eq(appEndorsementEdges.memberId, memberId),
          sourceId === null
            ? isNull(appEndorsementEdges.sourceId)
            : eq(appEndorsementEdges.sourceId, sourceId)
        )
      )
      .returning({ weight: appEndorsementEdges.weight });
    if (!removed) {
      // Removing an edge that was never applied is a no-op.
      result.skipped += 1;
      return;
    }

    // Subtract exactly the weight that was applied when the edge was added,
    // regardless of the owner's current reputation.
    await db
      .update(appUserSignals)
      .set({
        endorsementScore: sql`${appUserSignals.endorsementScore} - ${removed.weight}`,
      })
      .where(
        and(
          eq(appUserSignals.applicationId, applicationId),
          eq(appUserSignals.userId, memberId)
        )
      );

    // The member's reputation award is intentionally NOT reversed here — an
    // endorsement that happened still happened; only the live ranking signal is
    // withdrawn. (Reversals are a staff/dispute action on the ledger.)
    result.removed += 1;
  }

  /**
   * Upsert a batch of interest signals for one application. Each item sets the
   * latest interest score (last write wins) on the member's per-app roll-up.
   */
  async ingestInterests(
    applicationId: string,
    items: AppInterestInput[]
  ): Promise<InterestIngestResult> {
    const db = getDb();
    const result: InterestIngestResult = { upserted: 0, invalid: 0 };

    for (const item of items) {
      try {
        await db
          .insert(appUserSignals)
          .values({
            applicationId,
            userId: item.userId,
            interestScore: item.interestScore,
          })
          .onConflictDoUpdate({
            target: [appUserSignals.applicationId, appUserSignals.userId],
            set: { interestScore: item.interestScore },
          });
        result.upserted += 1;
      } catch (error) {
        if (!isForeignKeyViolation(error)) {
          throw error;
        }
        logger.warn('appSignals: interest signal rejected by a foreign key', {
          component: 'appSignals.service',
          applicationId,
          userId: item.userId,
        });
        result.invalid += 1;
      }
    }

    return result;
  }

  /**
   * Fold a batch of directed interaction events into per-app affinity edges.
   *
   * For each valid event `fromUserId → toUserId` (self-edges and unknown ids
   * rejected; a supplied `eventId` deduped via the bounded
   * `app_affinity_seen_events` ledger): the existing edge's stored `affinity` is
   * DECAYED from its `lastEventAt` to now, then the event's additive weight (a
   * caller override or the per-type default) is ADDED; `lastEventAt` is advanced
   * to the event time (or now) and `eventCount` incremented. A missing edge is
   * created at the event's weight.
   *
   * Correctness-first and independent per event: a single bad event never fails
   * the batch, and the whole operation is a strict no-op when `events` is empty.
   */
  async ingestAffinityEvents(
    applicationId: string,
    events: AppAffinityEvent[]
  ): Promise<AffinityIngestResult> {
    const result: AffinityIngestResult = {
      applied: 0,
      edgesCreated: 0,
      duplicate: 0,
      invalid: 0,
    };

    for (const event of events) {
      // Reject self-edges: a user cannot build affinity toward themselves — it
      // would only pollute their own recommendation surface.
      if (event.fromUserId === event.toUserId) {
        result.invalid += 1;
        continue;
      }

      const weight = affinityEventWeight(event.type, event.weight);
      // A zero weight (unknown type with no override) carries no affinity — skip
      // it as invalid rather than touching the edge / advancing its decay clock.
      if (weight <= 0) {
        result.invalid += 1;
        continue;
      }

      // Idempotency: an app-supplied eventId is folded at most once. The unique
      // (applicationId, eventId) index + the expiry sweep bound the ledger; a
      // conflicting insert (or a pre-existing marker) marks the event as seen.
      // `AppAffinityEventSeen.eventId` was `trim: true` in Mongoose, which has no
      // Postgres counterpart — re-applied here so the two spellings of one id
      // cannot both reserve.
      const eventId = event.eventId?.trim();
      if (eventId) {
        const alreadySeen = await this.reserveAffinityEventId(applicationId, eventId);
        if (alreadySeen) {
          result.duplicate += 1;
          continue;
        }
      }

      const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
      const eventAt = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

      await this.foldAffinityEdge(
        applicationId,
        event.fromUserId,
        event.toUserId,
        weight,
        eventAt,
        result
      );
    }

    return result;
  }

  /**
   * Record an app-supplied `eventId` as seen for this application. Returns `true`
   * when the id was ALREADY seen (this delivery is a duplicate), `false` when it
   * was newly reserved (fold it). Concurrent duplicate deliveries resolve to
   * "already seen" for every loser of the unique-index race, so an event folds at
   * most once.
   */
  private async reserveAffinityEventId(
    applicationId: string,
    eventId: string
  ): Promise<boolean> {
    const reserved = await getDb()
      .insert(appAffinitySeenEvents)
      .values({ applicationId, eventId })
      .onConflictDoNothing({
        target: [appAffinitySeenEvents.applicationId, appAffinitySeenEvents.eventId],
      })
      .returning({ id: appAffinitySeenEvents.id });
    return reserved.length === 0;
  }

  /**
   * Decay-then-add one interaction onto a directed affinity edge, creating it
   * when absent.
   *
   * The decay itself stays in `decayAffinity` — the one tested source of truth
   * for the half-life curve — so the stored value is read, decayed in
   * TypeScript, and written back by a single conflict-aware insert. `xmax = 0`
   * in the `returning` distinguishes a real insert from the conflict path, which
   * is what keeps `edgesCreated` honest when two deliveries race.
   */
  private async foldAffinityEdge(
    applicationId: string,
    fromUserId: string,
    toUserId: string,
    weight: number,
    eventAt: Date,
    result: AffinityIngestResult
  ): Promise<void> {
    const db = getDb();
    const now = Date.now();

    const [existing] = await db
      .select({
        affinity: appAffinityEdges.affinity,
        lastEventAt: appAffinityEdges.lastEventAt,
      })
      .from(appAffinityEdges)
      .where(
        and(
          eq(appAffinityEdges.applicationId, applicationId),
          eq(appAffinityEdges.fromUserId, fromUserId),
          eq(appAffinityEdges.toUserId, toUserId)
        )
      )
      .limit(1);

    const decayed = decayAffinity(existing?.affinity ?? 0, existing?.lastEventAt ?? null, now);
    // Advance the decay reference to the later of the stored point and this
    // event so an out-of-order (older) event never rewinds the edge's clock.
    const storedMs = existing?.lastEventAt ? existing.lastEventAt.getTime() : 0;
    const nextLastEventAt = eventAt.getTime() >= storedMs ? eventAt : new Date(storedMs);

    let created: boolean;
    try {
      const [row] = await db
        .insert(appAffinityEdges)
        .values({
          applicationId,
          fromUserId,
          toUserId,
          affinity: weight,
          lastEventAt: eventAt,
          eventCount: 1,
        })
        .onConflictDoUpdate({
          target: [
            appAffinityEdges.applicationId,
            appAffinityEdges.fromUserId,
            appAffinityEdges.toUserId,
          ],
          set: {
            affinity: decayed + weight,
            lastEventAt: nextLastEventAt,
            eventCount: sql`${appAffinityEdges.eventCount} + 1`,
          },
        })
        .returning({ created: sql<boolean>`xmax = 0` });
      created = row.created;
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      logger.warn('appSignals: affinity event rejected by a foreign key', {
        component: 'appSignals.service',
        applicationId,
        fromUserId,
        toUserId,
      });
      result.invalid += 1;
      return;
    }

    result.applied += 1;
    if (created) {
      result.edgesCreated += 1;
    }
  }
}

export const appSignalsService = new AppSignalsService();
export default appSignalsService;
