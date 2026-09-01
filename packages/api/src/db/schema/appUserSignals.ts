/**
 * `app_user_signals` — the per-(application, user) roll-up of cross-app
 * discovery signals the recommendation scorer reads.
 *
 * Ported from `models/AppUserSignal.ts`.
 *
 * ## `endorsement_count` does NOT travel; `endorsement_score` does
 *
 * Both were maintained by `$inc` in `appSignals.service.ts`, and
 * `CONVENTIONS.md` says a denormalized counter travels only against a
 * measurement. They get opposite answers because the queries are not the same
 * shape:
 *
 * - **`endorsement_count` is dropped.** Nothing reads it — the only mentions in
 *   the entire repo are the two `$inc`s that maintain it
 *   (`appSignals.service.ts:205`, `:263`). Should a reader ever appear,
 *   `count(*) from app_endorsement_edges where application_id = $1 and
 *   member_id = $2` is a direct hit on that table's existing index.
 * - **`endorsement_score` stays**, and the reason is structural rather than a
 *   timing measurement: the read is
 *   `find({applicationId}).sort({endorsementScore: -1}).limit(N)`
 *   (`routes/profiles.ts:1047`) — a TOP-N over every user of an application, on
 *   the recommendation path. Its aggregate form is
 *   `select member_id, sum(weight) … group by member_id order by 2 desc limit N`,
 *   and no index can serve an ordering by an aggregate: every request would scan
 *   one application's entire edge set. Materialized, the same answer is an
 *   index-ordered top-N. `app_endorsement_edges` remains the source of truth and
 *   this column is recomputable from it at any time.
 *
 * The table would exist regardless: `interest_score` and `last_endorsed_at` are
 * reported directly by the application and are not derivable from any edge.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const appUserSignals = pgTable(
  'app_user_signals',
  {
    id: generatedId(),
    /** `CASCADE` — a signal scoped to an application that is gone ranks nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The user the signals are about. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Signed sum of applied endorsement weights within this app. Materialized —
     * see the header. Signed, not clamped: a `remove` subtracts the weight that
     * was added, and float arithmetic can leave a small negative residue after
     * an add/remove cycle, so a `>= 0` CHECK here would reject a correct write.
     */
    endorsementScore: doublePrecision().notNull().default(0),
    /**
     * Latest app-reported interest signal. The contract already constrains it to
     * [0, 1] (`appUserSignalIngestSchema`,
     * `contracts/src/recommendations.ts:135`); the CHECK below states the same
     * bound for the write paths that do not go through it.
     */
    interestScore: doublePrecision().notNull().default(0),
    lastEndorsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One roll-up per (application, user) — what makes the ingest `$inc` an
    // upsert rather than a duplicate.
    unique('app_user_signals_application_id_user_id_key').on(t.applicationId, t.userId),
    // ADDED, not ported: the scorer's top-N read
    // (`find({applicationId}).sort({endorsementScore:-1}).limit(N)`,
    // `routes/profiles.ts:1047`) has no supporting index in Mongo at all, so it
    // fetches every row for the application and sorts them in memory.
    index('app_user_signals_application_id_endorsement_score_idx').on(
      t.applicationId,
      t.endorsementScore.desc()
    ),
    // Cross-app lookups for a single user, and the index that keeps a user
    // delete from scanning the table.
    index('app_user_signals_user_id_idx').on(t.userId),
    check(
      'app_user_signals_interest_score_check',
      sql`${t.interestScore} >= 0 and ${t.interestScore} <= 1`
    ),
  ]
);
