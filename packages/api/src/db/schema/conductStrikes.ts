/**
 * `conduct_strikes` — the unit of ACTIVE RISK on a user's conduct axis.
 *
 * Ported from `models/ConductStrike.ts`. A strike is what makes conduct
 * independent of contribution: the ledger transaction records what an incident
 * cost in points, the strike records that the person is currently under
 * consequence, and standing derives from the sum of risk carried by `active`
 * strikes and from nothing else — so earning points cannot cancel one.
 *
 * ## `expires_at` is NOT a TTL, and must never be registered as one
 *
 * Mongo indexed it with a `partialFilterExpression`, not `expireAfterSeconds`.
 * A due strike is RESOLVED — `status` moves to `expired` and the ledger row
 * survives, because a minor error must not become a permanent condemnation and
 * must not become an erased one either. Adding this column to
 * `EXPIRY_SWEEP_TARGETS` would delete the audit trail the model exists to keep.
 * The partial index below is the one the resolution job scans.
 *
 * ## `policy_version` is a foreign key now
 *
 * It names the Oxy Conduct Policy version the consequence was derived under, so
 * the consequence can be recomputed under it. In Mongo that was an unchecked
 * string; here it references `moderation_policies.policy_version` with
 * `ON DELETE RESTRICT` — a version may not be deleted while a strike was derived
 * under it. See `moderationPolicies.ts`.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import {
  CONDUCT_STRIKE_STATUSES,
  MODERATION_EFFECT_TYPES,
  MODERATION_SEVERITIES,
} from '@oxyhq/contracts';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { moderationPolicies } from './moderationPolicies';
import { reputationTransactions } from './reputationTransactions';
import { users } from './users';

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const conductStrikes = pgTable(
  'conduct_strikes',
  {
    id: generatedId(),
    /**
     * The subject under consequence. `CASCADE`: a strike names a person, and an
     * erased account leaves no person to be under consequence.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The cross-tenant incident that produced it. THE unit of consequence. */
    incidentId: text().notNull(),
    /** The decision that produced it. */
    decisionId: text().notNull(),
    /** Revision of that decision. An appeal's revision creates its own strike. */
    decisionRevision: integer().notNull(),
    /**
     * Which application's report started the incident. `SET NULL`, as the
     * deferred-FK ledger decided before `applications` landed: this is
     * attribution and the column is already nullable, so a strike stands on its
     * own decision and an unattributed one is a real state rather than a
     * corrupted one.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /**
     * Which axis the strike came from. Part of the uniqueness key: a person who
     * is both the author of violating material and a colluding reviewer in one
     * incident carries two distinct consequences, not one merged strike.
     */
    effectType: text({ enum: MODERATION_EFFECT_TYPES }).notNull(),
    severity: text({ enum: MODERATION_SEVERITIES }).notNull(),
    /** Active risk contributed while `status` is `active`, already multiplied. */
    riskPoints: doublePrecision().notNull(),
    /** Conduct family, not the taxonomy code — no intimate category is stored. */
    family: text().notNull(),
    status: text({ enum: CONDUCT_STRIKE_STATUSES }).notNull().default('active'),
    /**
     * When the risk lapses. Absent for critical severity, which requires a
     * specialised recovery review instead of expiring on its own. See the header
     * for why this is not a TTL column.
     */
    expiresAt: timestamptz(),
    /**
     * The policy version the consequence was derived under. The constraint is
     * declared in the table config below: drizzle's derived name for it is 68
     * characters and Postgres truncates an identifier at 63.
     */
    policyVersion: text().notNull(),
    /**
     * The ledger transaction the strike accompanies.
     *
     * `RESTRICT`, same reasoning as `moderation_effects.transaction_id`: the
     * ledger reverses rather than deletes. Verified against a real Postgres to
     * not block the account-erasure cascade — `user_id` removes this row first.
     */
    transactionId: text()
      .notNull()
      .references(() => reputationTransactions.id, { onDelete: 'restrict' }),
    /** When the strike stopped being active, if it has. */
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.policyVersion],
      foreignColumns: [moderationPolicies.policyVersion],
      name: 'conduct_strikes_policy_version_fk',
    }).onDelete('restrict'),
    // ONE strike per incident, subject, effect type and decision revision. This
    // index — not a read-then-write in the service — is what makes "one penalty
    // per incident" hold under a concurrent replay of the same event, and it
    // mirrors `moderation_effects`' semantic key exactly so a strike and its
    // effect can never disagree about how many consequences an incident produced.
    unique('conduct_strikes_incident_id_user_id_effect_type_revision_key').on(
      t.incidentId,
      t.userId,
      t.effectType,
      t.decisionRevision
    ),
    // Summing a user's active risk. Mongo also declared a standalone `{userId}`;
    // dropped as redundant, since a btree serves any leading prefix.
    index('conduct_strikes_user_id_status_idx').on(t.userId, t.status),
    // Repetition assessment: prior similar incidents for a subject, by family.
    index('conduct_strikes_user_id_family_created_at_idx').on(
      t.userId,
      t.family,
      t.createdAt.desc()
    ),
    // Reversal resolves every strike a decision revision produced.
    index('conduct_strikes_decision_id_decision_revision_idx').on(
      t.decisionId,
      t.decisionRevision
    ),
    // The resolution job: due active strikes, oldest first. Mongo's
    // `partialFilterExpression: { status: 'active', expiresAt: { $exists: true } }`
    // — partial here for the same reason, so the index holds only rows the job
    // can act on.
    index('conduct_strikes_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active' and ${t.expiresAt} is not null`),

    check(
      'conduct_strikes_effect_type_check',
      sql`${t.effectType} in (${sql.raw(inList(MODERATION_EFFECT_TYPES))})`
    ),
    check(
      'conduct_strikes_severity_check',
      sql`${t.severity} in (${sql.raw(inList(MODERATION_SEVERITIES))})`
    ),
    check(
      'conduct_strikes_status_check',
      sql`${t.status} in (${sql.raw(inList(CONDUCT_STRIKE_STATUSES))})`
    ),
    // A revision is an ordinal, starting at the decision's first publication.
    check('conduct_strikes_decision_revision_check', sql`${t.decisionRevision} >= 0`),
    // A strike stops carrying risk exactly when it is resolved. Both paths out
    // of `active` set `resolved_at` in the same write — `expired`
    // (`moderationReputation.service.ts:651`) and `reversed` (`:534`) — so the
    // pair is whole or absent, and "not active but never resolved" (a state
    // every reader had to guard for) becomes unrepresentable.
    check(
      'conduct_strikes_resolution_complete_check',
      sql`(${t.status} = 'active') = (${t.resolvedAt} is null)`
    ),
  ]
);
