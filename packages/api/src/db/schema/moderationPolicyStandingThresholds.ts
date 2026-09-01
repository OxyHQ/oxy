/**
 * `moderation_policy_standing_thresholds` — the active-risk level at which one
 * conduct standing begins, under one policy version.
 *
 * Ported from the `standingThresholds` array embedded in
 * `models/ModerationPolicy.ts`. Same reasoning as its sibling
 * `moderation_policy_severity_rules`: a known-shape array of records, with one
 * entry per standing, so a child table with a unique constraint says what
 * `jsonb` could only imply.
 *
 * The array was ordered "highest first" and the order is NOT reproduced as a
 * position column, because it is not data: the ordering is derivable from
 * `min_risk` itself, and a stored position could disagree with it. Reads sort by
 * `min_risk desc`.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, foreignKey, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { CONDUCT_STANDINGS, type ConductStanding } from '@oxyhq/contracts';
import { generatedId } from '@oxyhq/db';
import { moderationPolicies } from './moderationPolicies';

/**
 * One standing band, as the policy states it.
 *
 * The two fields the band actually IS, without the row's own id or its policy
 * link — which is what a caller deriving a standing holds: the baseline tuple
 * in `utils/moderation.constants.ts` has no row behind it at all.
 */
export interface ConductStandingThreshold {
  standing: ConductStanding;
  minRisk: number;
}

export const moderationPolicyStandingThresholds = pgTable(
  'moderation_policy_standing_thresholds',
  {
    id: generatedId(),
    /**
     * The version this threshold belongs to. Declared below rather than inline
     * for the same reason as its sibling: drizzle's derived constraint name is
     * 73 characters and Postgres truncates at 63.
     */
    policyId: text().notNull(),
    standing: text({ enum: CONDUCT_STANDINGS }).notNull(),
    /** Active risk at or above which this standing applies. */
    minRisk: doublePrecision().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.policyId],
      foreignColumns: [moderationPolicies.id],
      name: 'moderation_policy_standing_thresholds_policy_id_fk',
    }).onDelete('cascade'),
    unique('moderation_policy_standing_thresholds_policy_id_standing_key').on(
      t.policyId,
      t.standing
    ),
    check(
      'moderation_policy_standing_thresholds_standing_check',
      sql`${t.standing} in (${sql.raw(CONDUCT_STANDINGS.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'moderation_policy_standing_thresholds_min_risk_check',
      sql`${t.minRisk} >= 0`
    ),
  ]
);
