/**
 * `validator_affinities` — the collusion throttle.
 *
 * Ported from `models/ValidatorAffinity.ts`. Counts how often a PAIR of jurors
 * has served on the same jury and voted the same way. `selectValidators` skips a
 * candidate with high affinity to an already-drawn juror, which is what breaks
 * up rings that try to validate each other.
 *
 * ## The pair is canonical, and the CHECK says so
 *
 * `affinityPair` (`validator.service.ts:78`) stores the lexicographically
 * smaller id as `validator_a`, so each unordered pair has exactly one row.
 * Mongo's unique index enforced only that a given ORDERED pair appears once —
 * `(b, a)` was a second, invisible row that silently halved every co-vote count
 * it should have been part of. `validator_a < validator_b` makes the canonical
 * form the only representable one, so the unique index means what its comment
 * always claimed.
 *
 * ## No timestamps
 *
 * `timestamps: false` in Mongoose, and the model declares no `createdAt` of its
 * own — `last_co_vote_at` is the only date the throttle reads. So this table has
 * neither `created_at` nor `updated_at`, and that absence is the port rather
 * than an omission.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

export const validatorAffinities = pgTable(
  'validator_affinities',
  {
    id: generatedId(),
    /** The lexicographically SMALLER of the two juror ids. */
    validatorA: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The lexicographically LARGER of the two juror ids. */
    validatorB: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Times the pair has co-voted the same way. */
    coVoteCount: integer().notNull().default(0),
    /** When they last co-voted. The throttle decays on it. */
    lastCoVoteAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('validator_affinities_pair_key').on(t.validatorA, t.validatorB),
    check('validator_affinities_co_vote_count_check', sql`${t.coVoteCount} >= 0`),
    // Canonical ordering. Strict `<` also rules out a self-pair, which would be
    // an account colluding with itself.
    check('validator_affinities_canonical_pair_check', sql`${t.validatorA} < ${t.validatorB}`),
  ]
);
