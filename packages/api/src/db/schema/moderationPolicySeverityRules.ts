/**
 * `moderation_policy_severity_rules` — what one severity costs under one policy
 * version.
 *
 * Ported from the `severityRules` array embedded in `models/ModerationPolicy.ts`
 * (a `_id: false` subdocument schema). A child table rather than `jsonb` because
 * the model states an invariant — "exactly one entry per severity" — that only a
 * unique constraint can actually hold.
 *
 * No timestamp columns: the subdocuments carried none, and every row is written
 * in the same statement as its parent, whose `created_at` already dates it.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { MODERATION_SEVERITIES } from '@oxyhq/contracts';
import { generatedId } from '@oxyhq/db';
import { moderationPolicies } from './moderationPolicies';

export const moderationPolicySeverityRules = pgTable(
  'moderation_policy_severity_rules',
  {
    id: generatedId(),
    /**
     * The version this rule belongs to. A rule outliving its policy is nothing.
     * The constraint is declared in the table config below rather than inline,
     * because drizzle's derived name for it is 68 characters and Postgres
     * silently truncates an identifier at 63 — a truncated constraint name is a
     * future collision waiting for the next sibling table.
     */
    policyId: text().notNull(),
    severity: text({ enum: MODERATION_SEVERITIES }).notNull(),
    /** Signed ledger points (negative). */
    points: doublePrecision().notNull(),
    /** Active risk this severity contributes to conduct standing. */
    riskPoints: doublePrecision().notNull(),
    /**
     * Days after which the strike's risk lapses.
     *
     * NULL is MEANINGFUL and is not "unset": it means the risk does not lapse
     * automatically and requires a specialised recovery review. Mongoose spelled
     * that as a nullable path with `default: null` for exactly this reason — the
     * ledger row survives either way, so traceability is never traded for
     * forgiveness.
     */
    riskExpiryDays: integer(),
  },
  (t) => [
    foreignKey({
      columns: [t.policyId],
      foreignColumns: [moderationPolicies.id],
      name: 'moderation_policy_severity_rules_policy_id_fk',
    }).onDelete('cascade'),
    // THE invariant: one rule per severity per version. A policy that tried to
    // price `high` twice would previously have been accepted and then resolved
    // by whichever entry the service happened to find first.
    unique('moderation_policy_severity_rules_policy_id_severity_key').on(
      t.policyId,
      t.severity
    ),
    check(
      'moderation_policy_severity_rules_severity_check',
      sql`${t.severity} in (${sql.raw(MODERATION_SEVERITIES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'moderation_policy_severity_rules_risk_expiry_days_check',
      sql`${t.riskExpiryDays} is null or ${t.riskExpiryDays} > 0`
    ),
  ]
);
