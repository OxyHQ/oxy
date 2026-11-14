/**
 * What Oxy's own services did for a person (ADR 0066), as the person reads it
 * in their account's security settings: which application, where, reading or
 * writing, how many times that day, first and last. One row per
 * (account, requester, application, receiver, effect, day), incremented on
 * every request an Oxy service makes for that person. Nothing of the request
 * itself (a file, a message, a tool argument) is stored here.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** How long a person can look back. */
export const FIRST_PARTY_DELEGATION_ACTIVITY_RETENTION_SECONDS = 400 * 86400;

export const firstPartyDelegationActivity = pgTable(
  'first_party_delegation_activity',
  {
    id: generatedId(),
    /** The account the service acted on: the person, or an account they operate. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The person it acted for; equals `accountId` unless they operate it. */
    requesterAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** `oxy:<area>` or the receiving application's id, as declared. */
    receiver: text().notNull(),
    effect: text({ enum: ['read', 'write'] }).notNull(),
    day: date({ mode: 'string' }).notNull(),
    count: integer().notNull().default(1),
    firstAt: timestamptz().notNull().defaultNow(),
    lastAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('first_party_delegation_activity_effect_check', sql`${t.effect} in ('read', 'write')`),
    check('first_party_delegation_activity_count_check', sql`${t.count} >= 1`),
    unique('first_party_delegation_activity_key').on(
      t.accountId,
      t.requesterAccountId,
      t.applicationId,
      t.receiver,
      t.effect,
      t.day,
    ),
    index('first_party_delegation_activity_account_idx').on(t.accountId, t.lastAt),
    index('first_party_delegation_activity_requester_idx').on(t.requesterAccountId, t.lastAt),
    index('first_party_delegation_activity_last_at_idx').on(t.lastAt),
  ],
);
