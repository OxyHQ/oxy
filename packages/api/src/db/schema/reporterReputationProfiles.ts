/**
 * `reporter_reputation_profiles` — a person's track record AS A REPORTER, kept
 * apart from everything else.
 *
 * Ported from `models/ReporterReputationProfile.ts`. It is its own table rather
 * than a few more columns on the balance because the legacy `abuseScore` folded
 * rejected reports together with every negative transaction, so a penalty for
 * unrelated conduct pushed a report-abuse figure upward — and that figure can
 * force a restriction. A separate table incremented only by reporting outcomes
 * makes that conflation structurally impossible rather than merely discouraged.
 *
 * ## The two per-family maps are `jsonb`, deliberately
 *
 * `CONVENTIONS.md` allows `jsonb` only for genuinely shape-less data, and these
 * qualify for a specific reason rather than by default: they are ASSOCIATIVE
 * ARRAYS over an OPEN key space, not records with known fields. A conduct family
 * is whatever the active `moderation_policies.conduct_families` says it is, so
 * there is no table to reference; nothing groups or joins by key (both maps are
 * read whole, with the profile); and the values are plain counts. A child table
 * would add a join to every read and enforce nothing that matters. The CHECK
 * constraints keep them objects rather than a dumping ground.
 *
 * ## What the counts deliberately do NOT say
 *
 * A rejected report is not bad faith — it lowers the accuracy estimate gently
 * and nothing else; only `malicious` records confirmed report abuse. A duplicate
 * report is neither right nor wrong: it is counted separately and moves no
 * estimate, so piling onto a live incident neither rewards nor punishes.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** A newcomer's neutral prior, so one accurate report does not certify them. */
const DEFAULT_RELIABILITY = 0.5;

export const reporterReputationProfiles = pgTable(
  'reporter_reputation_profiles',
  {
    id: generatedId(),
    /** The reporter. One profile per account; erasure takes it with the account. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Reports that led to a confirmed violation. */
    confirmed: integer().notNull().default(0),
    /** Reports reviewed and rejected. Not an accusation of bad faith. */
    rejected: integer().notNull().default(0),
    /** Reports that duplicated a live incident. Moves no estimate. */
    duplicate: integer().notNull().default(0),
    /** CONFIRMED report abuse: manipulation, harassment-by-reporting, automation. */
    malicious: integer().notNull().default(0),
    /** Conduct family → confirmed count, for category-aware weighting. */
    confirmedByFamily: jsonb().notNull().default({}),
    /** Conduct family → rejected count. */
    rejectedByFamily: jsonb().notNull().default({}),
    /** Smoothed 0..1 accuracy estimate (Beta posterior mean). */
    reliability: doublePrecision().notNull().default(DEFAULT_RELIABILITY),
    /** 0..1 confidence in that estimate, from effective sample size. */
    confidence: doublePrecision().notNull().default(0),
    /** Most recent reporting outcome folded in. */
    lastOutcomeAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongo's `unique: true` on `userId`. It is also the only access path, so
    // there is no second index: a btree serves the equality this leads with.
    unique('reporter_reputation_profiles_user_id_key').on(t.userId),

    check(
      'reporter_reputation_profiles_confirmed_by_family_object_check',
      sql`jsonb_typeof(${t.confirmedByFamily}) = 'object'`
    ),
    check(
      'reporter_reputation_profiles_rejected_by_family_object_check',
      sql`jsonb_typeof(${t.rejectedByFamily}) = 'object'`
    ),
    // Counts and probabilities have ranges, and a value outside one is a bug in
    // the estimator rather than a datum to store.
    check(
      'reporter_reputation_profiles_counts_check',
      sql`${t.confirmed} >= 0 and ${t.rejected} >= 0 and ${t.duplicate} >= 0 and ${t.malicious} >= 0`
    ),
    check(
      'reporter_reputation_profiles_reliability_check',
      sql`${t.reliability} >= 0 and ${t.reliability} <= 1`
    ),
    check(
      'reporter_reputation_profiles_confidence_check',
      sql`${t.confidence} >= 0 and ${t.confidence} <= 1`
    ),
  ]
);
