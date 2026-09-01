/**
 * `validation_requests` (+ the jury junction table) — a claim put to a randomly
 * selected jury of trusted peers.
 *
 * Ported from `models/ValidationRequest.ts`. Lifecycle:
 * `pending` → (`quorum_met`) → `validated` | `rejected`, or `expired` if quorum
 * is never reached. The selection is AUDITABLE: `rng_seed` plus
 * `candidate_snapshot` record exactly why these jurors were drawn.
 *
 * ## The dedup constraint moves back into the database
 *
 * `ValidationRequest.ts:83-84` says the open-request dedup "is enforced in the
 * service — partialFilterExpression does not portably support `$in`". That is a
 * MongoDB limitation, not a design decision, and Postgres has no such
 * limitation:
 *
 *     UNIQUE (source_action_id) WHERE status IN ('pending', 'quorum_met')
 *
 * So it comes back. `openValidationRequest` currently does a `findOne` and then
 * a `create` — a check-then-act with a real window in which two concurrent
 * callers both find nothing and both open a jury for the same action, which
 * splits the juror pool across two requests that can each only expire. The index
 * closes that window and doubles as the index the `findOne` needs, so the
 * separate `{sourceActionId, status}` index is dropped as redundant rather than
 * ported. The service keeps its lookup (returning the existing request is the
 * friendly path); the constraint is what makes the guarantee true under
 * concurrency.
 *
 * ## `selected_validator_ids[]` becomes a junction table
 *
 * It is an array of user ids with a multikey index driving the juror-inbox
 * query, which is the exact shape `CONVENTIONS.md` requires to become a real
 * junction with real foreign keys. Mongo could hold a juror id that no longer
 * names an account; here it cannot.
 *
 * ## `candidate_snapshot` stays `jsonb`, and `payload` too
 *
 * `candidate_snapshot` is write-once audit evidence of a selection that already
 * happened — never joined, never filtered, never counted. Normalising it would
 * add a table whose only query is "give me the whole thing", and the ids in it
 * are deliberately a FROZEN record of the pool at selection time, so foreign
 * keys would let a later deletion rewrite the audit trail.
 *
 * `payload` is the arbitrary claim body the jurors inspect, shaped by whichever
 * application opened the request, and `payload_hash` is what the signed verdict
 * actually binds to. `jsonb` here is the intended use of the type.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { reputationTransactions } from './reputationTransactions';
import { users } from './users';

/** Request lifecycle. */
export const VALIDATION_REQUEST_STATUSES = [
  'pending',
  'quorum_met',
  'validated',
  'rejected',
  'expired',
] as const;

/** The two statuses in which a request is still OPEN and holds the dedup slot. */
export const OPEN_VALIDATION_REQUEST_STATUSES = ['pending', 'quorum_met'] as const;

/** Terminal verdict of a tallied request. */
export const VALIDATION_OUTCOMES = ['validated', 'rejected'] as const;

/** One entry of the audit snapshot of the candidate pool at selection time. */
export interface ValidationCandidateSnapshotEntry {
  userId: string;
  weight: number;
}

export const validationRequests = pgTable(
  'validation_requests',
  {
    id: generatedId(),
    /** The account whose claim is being validated. `CASCADE` — the claim is theirs. */
    subjectUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What is being validated. Drives the award and the slash. */
    actionType: text().notNull(),
    /** The opening application. Constraint deferred until `applications` lands. */
    applicationId: text()
      .references(() => applications.id, { onDelete: 'set null' }),
    /** Idempotency / dedup key for the underlying action. */
    sourceActionId: text().notNull(),
    /** The claim body the jurors inspect. */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the canonical payload — the signed verdict binds to THIS. */
    payloadHash: text().notNull(),
    status: text({ enum: VALIDATION_REQUEST_STATUSES }).notNull().default('pending'),
    /** Votes required to tally. */
    quorum: integer().notNull(),
    /** Votes required on the winning side. A supermajority for high-value claims. */
    threshold: integer().notNull(),
    highValue: boolean().notNull().default(false),
    /** Hex RNG seed of the weighted-reservoir selection. Audit only. */
    rngSeed: text().notNull(),
    /** `{userId, weight}` of the candidate pool at selection time. Audit only. */
    candidateSnapshot: jsonb()
      .$type<ValidationCandidateSnapshotEntry[]>()
      .notNull()
      .default([]),
    expiresAt: timestamptz().notNull(),
    outcome: text({ enum: VALIDATION_OUTCOMES }),
    /**
     * The `peer_validated` transaction created on a `validated` outcome.
     *
     * `SET NULL`, not `CASCADE`: the award is a CONSEQUENCE of the request, so
     * losing the award must not erase the jury's decision and its audit trail.
     * The column is already nullable — every request has no award until it is
     * tallied — so NULL is a state every reader handles.
     */
    resolvedTxnId: text().references(() => reputationTransactions.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('validation_requests_subject_user_id_idx').on(t.subjectUserId),
    // The expiry sweep: pending requests past their deadline. NOT an
    // `EXPIRY_SWEEP_TARGETS` entry — Mongo had no TTL index here either, and the
    // sweep TRANSITIONS a request to `expired` rather than deleting it. The row
    // is the audit record of a jury that failed to reach quorum.
    index('validation_requests_status_expires_at_idx').on(t.status, t.expiresAt),
    // The dedup constraint Mongo could not express. See the header.
    uniqueIndex('validation_requests_open_source_action_key')
      .on(t.sourceActionId)
      .where(sql`${t.status} in (${sql.raw(inList(OPEN_VALIDATION_REQUEST_STATUSES))})`),

    check(
      'validation_requests_status_check',
      sql`${t.status} in (${sql.raw(inList(VALIDATION_REQUEST_STATUSES))})`
    ),
    check(
      'validation_requests_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${sql.raw(inList(VALIDATION_OUTCOMES))})`
    ),
    check('validation_requests_quorum_check', sql`${t.quorum} > 0`),
    // The winning side needs at least a quorum's worth of agreement; a
    // supermajority raises it further. A threshold below the quorum would let a
    // request resolve on fewer votes than it required to tally at all.
    check('validation_requests_threshold_check', sql`${t.threshold} >= ${t.quorum}`),
    // A terminal verdict and a terminal status arrive together. Mongo could
    // store `validated` with no outcome, which the tally reader cannot show.
    check(
      'validation_requests_terminal_check',
      sql`(${t.status} in ('validated', 'rejected') and ${t.outcome} is not null and ${t.status} = ${t.outcome}) or (${t.status} in ('pending', 'quorum_met', 'expired') and ${t.outcome} is null)`
    ),
  ]
);

/**
 * `validation_request_validators` — the selected jury.
 *
 * The juror inbox ("my pending requests") is the query this exists for, so it
 * gets its own index on the juror; the primary key serves the reverse direction
 * ("was this account selected for this request?"), which every vote submission
 * checks.
 *
 * `position` preserves the weighted-reservoir draw ORDER, which is part of what
 * `rng_seed` + `candidate_snapshot` let an auditor reproduce.
 */
export const validationRequestValidators = pgTable(
  'validation_request_validators',
  {
    /** `CASCADE` — a jury seat on a request that no longer exists. */
    requestId: text()
      .notNull()
      .references(() => validationRequests.id, { onDelete: 'cascade' }),
    /**
     * The selected juror.
     *
     * `CASCADE`: a deleted account cannot vote, and leaving the seat would let a
     * request wait for a juror who can never arrive. The tally reads the votes
     * that were actually cast, so removing an unfilled seat changes no verdict.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Zero-based draw order from the weighted reservoir. */
    position: integer().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.requestId, t.userId],
      name: 'validation_request_validators_pkey',
    }),
    // The juror inbox: this account's seats, joined to the open requests.
    index('validation_request_validators_user_id_idx').on(t.userId),
    uniqueIndex('validation_request_validators_position_key').on(t.requestId, t.position),
    check('validation_request_validators_position_check', sql`${t.position} >= 0`),
  ]
);
