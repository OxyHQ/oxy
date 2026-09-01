/**
 * `reputation_rules` — the configurable award/penalty table.
 *
 * Ported from `models/ReputationRule.ts`. `award()` looks the enabled rule up by
 * `action_type` and takes the signed `points` and the `category` from it, so a
 * client can never choose its own points.
 *
 * `action_type` was `trim: true` in Mongoose, which is APPLICATION behaviour
 * with no Postgres counterpart — re-apply it at the call site on port
 * (`CONVENTIONS.md`, "Mongoose behaviour that has no schema counterpart"). It is
 * deliberately not a CHECK: a CHECK would reject an untrimmed production row
 * during backfill and convert a silent normalization into a failed migration.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { REPUTATION_CATEGORIES as CONTRACT_REPUTATION_CATEGORIES } from '@oxyhq/contracts';
import type { ReputationCategory } from '@oxyhq/contracts';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

/**
 * Category buckets a transaction may be filed under, from the contract so the
 * CHECK cannot drift from the Zod schema the routes validate with. `satisfies`
 * proves every value is a contract category; `ReputationCategoryGap` proves the
 * reverse, so widening the contract fails this file's typecheck.
 */
export const REPUTATION_CATEGORIES = [
  ...CONTRACT_REPUTATION_CATEGORIES,
] as const satisfies readonly ReputationCategory[];

/** `never` while `REPUTATION_CATEGORIES` covers the contract union. */
export type ReputationCategoryGap = Exclude<
  ReputationCategory,
  (typeof REPUTATION_CATEGORIES)[number]
>;

export const reputationRules = pgTable(
  'reputation_rules',
  {
    id: generatedId(),
    /** Unique action key, e.g. `post_created`. */
    actionType: text().notNull().unique(),
    /** Signed points. Negative for a penalty. */
    points: integer().notNull(),
    category: text({ enum: REPUTATION_CATEGORIES }).notNull(),
    description: text().notNull(),
    /** Per (user, action) cooldown; `0` disables it. */
    cooldownInMinutes: integer().notNull().default(0),
    isEnabled: boolean().notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'reputation_rules_category_check',
      sql`${t.category} in (${sql.raw(inList(REPUTATION_CATEGORIES))})`
    ),
    check('reputation_rules_cooldown_check', sql`${t.cooldownInMinutes} >= 0`),
  ]
);
