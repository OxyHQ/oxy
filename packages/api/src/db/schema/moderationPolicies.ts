/**
 * `moderation_policies` — one IMMUTABLE version of the Oxy Conduct Policy.
 *
 * Ported from `models/ModerationPolicy.ts`. A row is written once at seed time
 * and then read-only; a new tuning is a NEW `policy_version`, never an edit, so
 * shipping one can never rewrite what a past decision cost. `status` moving
 * `active` → `retired` is the only mutation the lifecycle allows.
 *
 * ## `policy_version` is a real key, and two tables now reference it
 *
 * `ConductStrike.policyVersion` and `ModerationEffect.policyVersions.oxyConduct`
 * both name a version so a consequence can be recomputed under the policy it was
 * derived under. In Mongo that was a string nobody checked — a strike could name
 * a version with no document, and the recomputation would simply find nothing.
 * Here `policy_version` carries a UNIQUE constraint and both columns reference
 * it with `ON DELETE RESTRICT`: a version may not be deleted while any
 * consequence was derived under it. That is the "no relational link may be lost"
 * directive applied to a link that was never enforced in the first place.
 *
 * The other two versions on an effect (`universal`, `application`) stay plain
 * text: they are the emitting system's policy identifiers, not rows here.
 *
 * ## The two arrays-of-subdocuments became child tables
 *
 * `severityRules` and `standingThresholds` are arrays of records with a fully
 * known shape, and the model's own comment says severity rules hold "exactly one
 * entry per severity". `jsonb` could hold them; it could not enforce that. As
 * child tables with `UNIQUE (policy_id, severity)` / `(policy_id, standing)`,
 * "exactly one entry per severity" stops being a sentence in a doc comment and
 * becomes a constraint — which is the whole point of the migration.
 *
 * The two SCALAR arrays stay native arrays, per `CONVENTIONS.md`:
 * `conduct_families` is a set of names read as a whole and never queried by
 * element, and `repetition_multipliers` is position-significant (index = ordinal
 * of the repeat), which a child table would only re-encode.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

/** `active` is used for new effects; `retired` remains resolvable. */
export const MODERATION_POLICY_STATUSES = ['active', 'retired'] as const;

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const moderationPolicies = pgTable(
  'moderation_policies',
  {
    id: generatedId(),
    /** e.g. `oxy.2026.1`. The key both consequence tables reference. */
    policyVersion: text().notNull(),
    status: text({ enum: MODERATION_POLICY_STATUSES }).notNull().default('active'),
    /**
     * Conduct families this version recognises. A finding whose family is absent
     * produces NO effect — an unrecognised category is never guessed at.
     */
    conductFamilies: text().array().notNull(),
    /**
     * Multipliers by ordinal of a similar incident in the window; the last value
     * holds beyond the array, which bounds the escalation. POSITION IS THE KEY,
     * so this is an array and not a child table.
     */
    repetitionMultipliers: doublePrecision().array().notNull(),
    /** Window, in days, over which a similar incident counts as repetition. */
    repetitionWindowDays: integer().notNull(),
    /** Share of the primary effect each secondary finding adds. */
    multiFindingSecondaryShare: doublePrecision().notNull(),
    /** Ceiling on the multi-finding multiplier, relative to the primary effect. */
    multiFindingCap: doublePrecision().notNull(),
    /**
     * Whether a decision still marked `provisional` may already move reputation.
     * The baseline is the conservative NO; a version may permit it for a narrow
     * class of severe, time-critical harm, which is why it is per-version.
     */
    provisionalEffectsAllowed: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('moderation_policies_policy_version_key').on(t.policyVersion),
    // `findOne({ status: 'active' })` — the lookup every new effect starts from.
    index('moderation_policies_status_idx').on(t.status),
    check(
      'moderation_policies_status_check',
      sql`${t.status} in (${sql.raw(inList(MODERATION_POLICY_STATUSES))})`
    ),
  ]
);
