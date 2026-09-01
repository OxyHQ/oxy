/**
 * `application_moderation_trust` — an application's own moderation standing, and
 * the gate on whether its decisions may touch global reputation.
 *
 * Ported from `models/ApplicationModerationTrust.ts`. An external application
 * can abuse the moderation system as readily as a person can — forged evidence,
 * unreliable identity bindings, a policy written to launder harassment — so the
 * application carries standing too, and `global_reputation_effects_allowed` is
 * the gate.
 *
 * ## The ABSENCE of a row is the safe default, which is why this is not columns
 *   on `applications`
 *
 * A newly-integrated application has NO trust row, and
 * `moderationReputation.service.ts:358` treats that as `sandbox` with global
 * effects DISALLOWED. Folding these fields into `applications` with defaults
 * would produce the same values but destroy the distinction between "never
 * reviewed" and "reviewed and set to the defaults" — and that distinction is
 * what a staff audit reads. A `UNIQUE` foreign key is the Postgres shape of an
 * OPTIONAL 1:1 extension, so the optionality survives.
 *
 * `standing` and the gate are separate columns on purpose: an application can be
 * `trusted` for prioritisation while global effects are still withheld, and a
 * `restricted` application keeps its history rather than being deleted.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { APPLICATION_MODERATION_STANDINGS } from '@oxyhq/contracts';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const applicationModerationTrust = pgTable(
  'application_moderation_trust',
  {
    id: generatedId(),
    /**
     * The application this standing is for. `CASCADE` — standing for an
     * application that no longer exists gates nothing.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * Imported straight from `@oxyhq/contracts` rather than copied: the tuple is
     * the shared cross-package vocabulary, and the Mongoose model reads the same
     * one, so the two cannot drift.
     */
    standing: text({ enum: APPLICATION_MODERATION_STANDINGS }).notNull().default('sandbox'),
    /** How well the application's evidence survives scrutiny. */
    evidenceIntegrity: doublePrecision().notNull().default(0),
    /** How well its identity bindings hold up under verification. */
    identityBindingReliability: doublePrecision().notNull().default(0),
    /** Share of its decisions overturned on appeal. */
    decisionOverturnRate: doublePrecision().notNull().default(0),
    /** Assessed quality of the application's own policy. */
    policyQuality: doublePrecision().notNull().default(0),
    /**
     * THE gate on global reputation effects. Defaults to false, and an absent
     * ROW is read as false too, so local-only is the safe default in both
     * states.
     */
    globalReputationEffectsAllowed: boolean().notNull().default(false),
    /**
     * The staff principal who last changed the gate. `SET NULL` — an audit
     * pointer must not be able to delete the standing it annotates, and NULL
     * ("the reviewer's account is gone") is the state Mongo already produced
     * silently as a dangling id.
     */
    reviewedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz(),
    /** Why the current standing was set. */
    reviewNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Exactly one standing per application — `findOne({applicationId})` is the
    // only read, and the uniqueness is what makes this a 1:1 extension rather
    // than a log.
    unique('application_moderation_trust_application_id_key').on(t.applicationId),
    // The staff review queue reads by standing, and unlike the low-cardinality
    // enums elsewhere in this batch the SELECTIVE value is the one asked for:
    // almost every row is `sandbox`, and the queue asks for `trusted` /
    // `restricted`.
    index('application_moderation_trust_standing_idx').on(t.standing),
    check(
      'application_moderation_trust_standing_check',
      sql`${t.standing} in (${sql.raw(inList(APPLICATION_MODERATION_STANDINGS))})`
    ),
    // All four are documented as 0..1 scores. Outside that range they do not
    // mean anything the consequence derivation can use.
    check(
      'application_moderation_trust_scores_check',
      sql`${t.evidenceIntegrity} between 0 and 1
        and ${t.identityBindingReliability} between 0 and 1
        and ${t.decisionOverturnRate} between 0 and 1
        and ${t.policyQuality} between 0 and 1`
    ),
  ]
);
