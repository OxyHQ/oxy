/**
 * `app_affinity_edges` — a directed, per-application interaction-affinity edge.
 *
 * Ported from `models/AppAffinityEdge.ts`. `affinity` is a decayed, additive
 * strength: each folded event decays the stored value from `last_event_at` to
 * now (exponential half-life) and ADDS the event's weight, and the
 * recommendation scorer decays it once more on read — so an edge that stops
 * receiving events fades toward zero and a dormant graph contributes nothing.
 *
 * The idempotency ledger that bounds ingest is a separate table,
 * `app_affinity_seen_events`, which the foundation already landed.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const appAffinityEdges = pgTable(
  'app_affinity_edges',
  {
    id: generatedId(),
    /** `CASCADE` — affinity accumulated inside an application that is gone ranks nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The interacting user — the viewer, on the read path. */
    fromUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The interacted-with user — a candidate, on the read path. */
    toUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Decayed, additive strength as of `last_event_at`. */
    affinity: doublePrecision().notNull().default(0),
    /**
     * The decay reference point. Nullable with NO default: Mongoose declared it
     * with neither, so an edge created before its first fold genuinely has none,
     * and `now()` would silently claim a fold that did not happen.
     */
    lastEventAt: timestamptz(),
    /** Events folded into this edge. Diagnostics and future weighting. */
    eventCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One directed edge per (application, from, to): re-ingesting an interaction
    // decays-then-adds onto the same edge instead of duplicating it, and a lost
    // create race resolves to the update path.
    // Named for what it enforces rather than by the usual
    // `<table>_<col>_<col>…_key` convention: the spelled-out name is exactly 63
    // characters, the point at which Postgres silently truncates, so it would
    // survive only by luck and any later column rename would push it over.
    unique('app_affinity_edges_directed_edge_key').on(
      t.applicationId,
      t.fromUserId,
      t.toUserId
    ),
    // The scorer's pre-query: a viewer's strongest affinities within an app
    // (`find({applicationId, fromUserId}).sort({affinity: -1})`,
    // `routes/profiles.ts:1069`). The unique above leads with the same two
    // columns but orders by `to_user_id`, so it cannot serve the sort.
    index('app_affinity_edges_application_id_from_user_id_affinity_idx').on(
      t.applicationId,
      t.fromUserId,
      t.affinity.desc()
    ),
    // Reverse fan-in (who has affinity toward a user), and the index that keeps
    // a user delete from scanning this table.
    index('app_affinity_edges_application_id_to_user_id_idx').on(t.applicationId, t.toUserId),
    // A user cannot build affinity toward themselves — it would only pollute
    // their own recommendation surface. `ingestAffinityEvents`
    // (`appSignals.service.ts:346`) already rejects a self-edge; stating it here
    // makes the row unrepresentable rather than merely unwritten by one path.
    check('app_affinity_edges_not_self_check', sql`${t.fromUserId} <> ${t.toUserId}`),
    // Every folded weight is strictly positive and decay only shrinks the value,
    // so a negative affinity is a fold bug, not a weak relationship.
    check(
      'app_affinity_edges_affinity_check',
      sql`${t.affinity} >= 0 and ${t.eventCount} >= 0`
    ),
  ]
);
