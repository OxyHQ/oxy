/**
 * `app_endorsement_edges` — one endorsement reported by a consuming app:
 * `owner_id` endorses `member_id`, optionally keyed to the app's own object.
 *
 * Ported from `models/AppEndorsementEdge.ts`. This is the SOURCE OF TRUTH for
 * `app_user_signals.endorsement_score` — the roll-up is recomputable at any time
 * by summing the live edges per `(application_id, member_id)`.
 *
 * `weight` is the OWNER's reputation-derived ranking weight AT APPLY TIME,
 * stored so a later `remove` subtracts exactly what was added even if the
 * owner's reputation has changed since.
 *
 * ## `source_id`: NULL, and `NULLS NOT DISTINCT`
 *
 * Mongo stored `''` for "unset" because the field is part of the idempotency
 * key, and `''` made the compound unique index behave. `''` must not travel:
 * `CONVENTIONS.md` is explicit that an empty string is a VALUE, and the contract
 * itself (`z.string().trim().min(1).optional()`,
 * `contracts/src/recommendations.ts:127`) says the wire form is a non-empty
 * string or nothing at all. So absent is NULL here.
 *
 * That alone would BREAK the guarantee, because Postgres treats NULLs in a
 * unique constraint as distinct — two unset edges for the same
 * (app, owner, member) would both insert and the endorsement would be counted
 * twice. `NULLS NOT DISTINCT` (Postgres 15+) restores exactly the Mongo
 * semantic without reintroducing the sentinel: one edge per
 * (application, owner, member, source), unset included.
 *
 * The alternative — a unique index on `coalesce(source_id, '')` — would work and
 * was rejected: it puts the sentinel back at every call site instead of in the
 * stored value, and a lookup that forgets the `coalesce` is correct-looking and
 * wrong.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const appEndorsementEdges = pgTable(
  'app_endorsement_edges',
  {
    id: generatedId(),
    /** `CASCADE` — an endorsement inside an application that is gone ranks nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The endorser. Their ranking weight at apply time is frozen into `weight`. */
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The endorsed. This is who the roll-up and the reputation award are for. */
    memberId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The app's own object key for the edge (a list id, a pack id). NULL means
     * the app named none — see the header.
     */
    sourceId: text(),
    /** The applied endorsement weight. A `remove` subtracts exactly this value. */
    weight: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Idempotency: one edge per (app, owner, member, source), with two unset
    // sources colliding as Mongo intended. See the header.
    //
    // Named for what it enforces rather than by the usual
    // `<table>_<col>_<col>…_key` convention: spelled out, this constraint's name
    // is 69 characters, and Postgres silently TRUNCATES an identifier at 63 —
    // so the name in this file would not be the name in the catalogue.
    unique('app_endorsement_edges_idempotency_key')
      .on(t.applicationId, t.ownerId, t.memberId, t.sourceId)
      .nullsNotDistinct(),
    // Recompute / fan-in for a single member within an app — the query that
    // rebuilds `app_user_signals.endorsement_score` from this ledger, and the
    // index that keeps a user delete from scanning the table.
    index('app_endorsement_edges_application_id_member_id_idx').on(t.applicationId, t.memberId),
    // A user cannot endorse themselves into the recommendation surface.
    // `ingestEndorsements` (`appSignals.service.ts:138`) already rejects it;
    // stating it here makes the row unrepresentable.
    check('app_endorsement_edges_not_self_check', sql`${t.ownerId} <> ${t.memberId}`),
    // An empty `source_id` is the sentinel this port exists to remove: NULL is
    // "unset", and `''` would be a second, silently-colliding spelling of it.
    check('app_endorsement_edges_source_id_check', sql`${t.sourceId} <> ''`),
  ]
);
