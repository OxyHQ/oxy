/**
 * `reviewer_reputation_profiles` — a person's track record AS A REVIEWER, per
 * category and language rather than as one global number.
 *
 * Ported from `models/ReviewerReputationProfile.ts`. Competence in one category
 * says very little about another, and a reviewer fluent in the language of the
 * material is not thereby calibrated on its policy — a single global figure
 * hides both, which is why the two maps exist.
 *
 * What moves these numbers, and what deliberately does not: gold cases are the
 * primary calibration signal; an accepted appeal is strong but never the only
 * one; DISAGREEING WITH THE MAJORITY does not penalise, because a jury that
 * punishes dissent stops being a jury. Collusion, leaking, random answering and
 * multi-account use are a different thing entirely — confirmed review abuse,
 * which suspends the profile and lands on the conduct axis.
 *
 * `seed_weight` is the small initial credit a reviewer's general Oxy reputation
 * lends before they have any review history, decaying to nothing as real history
 * accumulates: standing in the wider network is a hint about a newcomer, not a
 * substitute for evidence.
 *
 * The two reliability maps are `jsonb` for the reason given in full in
 * `reporterReputationProfiles.ts`: associative arrays over an OPEN key space
 * (moderation categories, BCP-47 language tags) with scalar values, read whole
 * and never joined on. `unlocked_categories` and `languages` are scalar arrays,
 * per `CONVENTIONS.md`.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** `active` reviewers can be drawn; `suspended` cannot. */
export const REVIEWER_PROFILE_STATUSES = ['active', 'probation', 'suspended'] as const;

/** The neutral prior a reviewer starts from, before any calibration. */
const DEFAULT_RELIABILITY = 0.5;

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const reviewerReputationProfiles = pgTable(
  'reviewer_reputation_profiles',
  {
    id: generatedId(),
    /** The reviewer. One profile per account. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: REVIEWER_PROFILE_STATUSES }).notNull().default('active'),
    /** Reviews whose decision matched the resolved outcome. */
    agreements: integer().notNull().default(0),
    /** Reviews whose decision did not. Not a penalty on its own. */
    disagreements: integer().notNull().default(0),
    /** Gold cases answered correctly — the primary calibration signal. */
    goldPassed: integer().notNull().default(0),
    /** Gold cases answered incorrectly. */
    goldFailed: integer().notNull().default(0),
    /** Decisions this reviewer contributed to that an appeal later overturned. */
    overturned: integer().notNull().default(0),
    /** Smoothed 0..1 global reliability. */
    globalReliability: doublePrecision().notNull().default(DEFAULT_RELIABILITY),
    /** Category → 0..1 reliability. Trusted in one and not another is normal. */
    categoryReliability: jsonb().notNull().default({}),
    /** Language tag → 0..1 reliability. */
    languageReliability: jsonb().notNull().default({}),
    /** Categories the reviewer has passed calibration for. */
    unlockedCategories: text().array().notNull().default([]),
    /** Languages the reviewer declared and was calibrated in. */
    languages: text().array().notNull().default([]),
    /** Initial credit from general Oxy standing, decaying toward zero. */
    seedWeight: doublePrecision().notNull().default(0),
    /** When the profile was suspended, if it was. */
    suspendedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('reviewer_reputation_profiles_user_id_key').on(t.userId),
    // Drawing a panel selects on status; Mongo declared the same index.
    index('reviewer_reputation_profiles_status_idx').on(t.status),

    check(
      'reviewer_reputation_profiles_status_check',
      sql`${t.status} in (${sql.raw(inList(REVIEWER_PROFILE_STATUSES))})`
    ),
    check(
      'reviewer_reputation_profiles_category_reliability_object_check',
      sql`jsonb_typeof(${t.categoryReliability}) = 'object'`
    ),
    check(
      'reviewer_reputation_profiles_language_reliability_object_check',
      sql`jsonb_typeof(${t.languageReliability}) = 'object'`
    ),
    check(
      'reviewer_reputation_profiles_counts_check',
      sql`${t.agreements} >= 0 and ${t.disagreements} >= 0 and ${t.goldPassed} >= 0 and ${t.goldFailed} >= 0 and ${t.overturned} >= 0`
    ),
    check(
      'reviewer_reputation_profiles_global_reliability_check',
      sql`${t.globalReliability} >= 0 and ${t.globalReliability} <= 1`
    ),
    // NOT added: a check pairing `status = 'suspended'` with `suspended_at`.
    // The pairing looks obvious and nothing maintains it — both profile tables
    // are read-only in the package today (`reputation.service.ts:829` and
    // `:849`), so the constraint would be a guess about a writer that does not
    // exist yet, and the first one to set the two in separate updates would meet
    // a 500. The equivalent checks on `conduct_strikes` and `moderation_effects`
    // are there precisely because their write paths were read and DO set both
    // fields in one statement.
  ]
);
