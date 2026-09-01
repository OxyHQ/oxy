/**
 * `user_analytics` — one user's aggregated activity for one period.
 *
 * Ported from `models/Analytics.ts`.
 *
 * ## Two renames, both deliberate
 *
 * - The Mongo collection is `analytics`, a mass noun that says nothing about
 *   what a row holds. Every row is one ACCOUNT's aggregate for one period, so
 *   the table is named for that and sits beside `user_locations`,
 *   `user_app_data` and the rest of the user-scoped set.
 * - **`userID` becomes `user_id`.** The capital-D spelling is unique to this one
 *   model — every other model in the package, ported or not, spells it `userId`
 *   — and carrying it would put a single irregular column into a schema whose
 *   naming is otherwise mechanical (`@oxyhq/db`'s casing module derives every SQL name from
 *   the property). The backfill's field map records `userID` → `user_id`; it is
 *   the only entry in this batch that is not an identity mapping.
 *
 * ## The nested `stats` object became flat columns
 *
 * `stats.engagement.*`, `stats.reach.*` and `stats.peakActivity.*` have a fully
 * known shape and are all plain counters, so they are real columns prefixed by
 * their group — not `jsonb`, and not a 1:1 child table that every row would
 * have exactly one of.
 *
 * The two `demographics` maps are the exception, for the reason spelled out in
 * `reporterReputationProfiles.ts`: they are associative arrays over an OPEN key
 * space (ISO country codes, BCP-47 language tags) with scalar values, read whole
 * and never joined on. There is no country table and no language table here to
 * reference, so a child table would add a join and enforce nothing.
 */

import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** The aggregation window a row covers. Mongo's `period` enum, unchanged. */
export const ANALYTICS_PERIODS = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/** Hours in a day — the range `peak_activity_hour` must fall in. */
const HOURS_PER_DAY = 24;

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const userAnalytics = pgTable(
  'user_analytics',
  {
    id: generatedId(),
    /** Whose activity. Erasing the account erases the aggregates about it. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    period: text({ enum: ANALYTICS_PERIODS }).notNull(),
    /** The instant the period starts. Reserved-word-adjacent but not reserved. */
    date: timestamptz().notNull(),

    // ---- stats -------------------------------------------------------------
    postViews: integer().notNull().default(0),
    profileViews: integer().notNull().default(0),

    engagementLikes: integer().notNull().default(0),
    engagementReplies: integer().notNull().default(0),
    engagementReposts: integer().notNull().default(0),
    engagementQuotes: integer().notNull().default(0),
    engagementBookmarks: integer().notNull().default(0),

    reachImpressions: integer().notNull().default(0),
    reachUniqueViewers: integer().notNull().default(0),

    /** ISO country code → count. See the header for why this is `jsonb`. */
    demographicsCountries: jsonb().notNull().default({}),
    /** BCP-47 language tag → count. */
    demographicsLanguages: jsonb().notNull().default({}),

    /** Hour of day, 0–23, with the most activity. */
    peakActivityHour: integer().notNull().default(0),
    peakActivityCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongo's `{userID, period, date}` unique — one aggregate per account per
    // window. It leads with `user_id`, so it also answers every "this account's
    // analytics" read; no second index.
    unique('user_analytics_user_id_period_date_key').on(t.userId, t.period, t.date),

    check(
      'user_analytics_period_check',
      sql`${t.period} in (${sql.raw(inList(ANALYTICS_PERIODS))})`
    ),
    // An hour outside the day is not a datum to store, it is a bug in whatever
    // computed it.
    check(
      'user_analytics_peak_activity_hour_check',
      sql`${t.peakActivityHour} >= 0 and ${t.peakActivityHour} < ${sql.raw(String(HOURS_PER_DAY))}`
    ),
    check(
      'user_analytics_demographics_countries_object_check',
      sql`jsonb_typeof(${t.demographicsCountries}) = 'object'`
    ),
    check(
      'user_analytics_demographics_languages_object_check',
      sql`jsonb_typeof(${t.demographicsLanguages}) = 'object'`
    ),
  ]
);
