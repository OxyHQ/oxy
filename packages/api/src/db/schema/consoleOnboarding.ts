/**
 * `console_onboarding` — a person's first-run answers in Oxy Console.
 *
 * One row per USER, not per workspace: the terms are accepted by the person
 * and carry across every account they act as. A person with no row has not
 * started; the API reports that as the empty state rather than creating a row
 * on read.
 *
 * `terms_version` is the version the person accepted (a date string,
 * `CONSOLE_TERMS_VERSION`), kept so a later bump asks them again. No IP, raw,
 * hashed or geo-derived, is stored: acceptance is evidenced by the user, the
 * version and the time alone (the no-IP invariant).
 *
 * `use_cases_answered_at` is set both when the person picks options and when
 * they skip, in which case `use_cases` stays empty. NULL means not asked yet.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, textArrayLiteral, timestamptz, updatedAt } from '@oxy.so/db';
import { CONSOLE_USE_CASES } from '@oxy.so/contracts/client';
import { users } from './users';

export const consoleOnboarding = pgTable(
  'console_onboarding',
  {
    /** The owner. `CASCADE`: the answers have no meaning without the person. */
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    termsVersion: text(),
    termsAcceptedAt: timestamptz(),
    adultAcknowledged: boolean().notNull().default(false),
    /** The "account may be suspended or terminated if I violate the AUP/Terms" checkbox. */
    aupAcknowledged: boolean().notNull().default(false),
    marketingOptIn: boolean().notNull().default(false),
    useCases: text().array().notNull().default(sql`'{}'::text[]`),
    /** Free text, trimmed, at most 2000 characters; NULL when none was given. */
    useCaseDescription: text(),
    useCasesAnsweredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'console_onboarding_use_case_description_check',
      sql`${t.useCaseDescription} is null or char_length(${t.useCaseDescription}) <= 2000`,
    ),
    check(
      'console_onboarding_use_cases_check',
      sql`${t.useCases} <@ ${sql.raw(textArrayLiteral(CONSOLE_USE_CASES))}`,
    ),
    // Accepted terms carry their version, time and both acknowledgements together.
    check(
      'console_onboarding_terms_complete_check',
      sql`(${t.termsVersion} is null) = (${t.termsAcceptedAt} is null) and (${t.termsVersion} is null or (${t.adultAcknowledged} and ${t.aupAcknowledged}))`,
    ),
  ],
);
