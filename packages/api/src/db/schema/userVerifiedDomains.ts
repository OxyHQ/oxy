/**
 * `user_verified_domains` — a domain the account has proven it controls.
 *
 * Ported from the `verifiedDomains` array embedded in `models/User.ts`. Written
 * ONLY by `POST /identity/domains/:domain/verify` after a DNS-TXT or
 * `/.well-known/oxy-domain` proof passes — never by a generic profile update.
 *
 * A child table because `verifiedDomains.domain` carried its own index: the
 * badge is looked up by domain, and an embedded array cannot answer that without
 * scanning every account.
 *
 * The badge is an `alsoKnownAs` entry in the DID document. It is NOT a handle —
 * a domain does not name an account.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

/** How ownership was proven. */
export const VERIFIED_DOMAIN_METHODS = ['dns-txt', 'well-known'] as const;

export const userVerifiedDomains = pgTable(
  'user_verified_domains',
  {
    id: generatedId(),
    /** `CASCADE` — a badge with no account behind it can never be displayed. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored as verified. Uniqueness and lookup both ignore case. */
    domain: text().notNull(),
    verifiedAt: timestamptz().notNull(),
    method: text({ enum: VERIFIED_DOMAIN_METHODS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // The route already refuses a duplicate by hand (`identity.ts:466` finds an
    // existing entry and updates it rather than pushing a second). Stating it
    // here means a second write path cannot reintroduce one.
    uniqueIndex('user_verified_domains_user_id_lower_domain_key').on(
      t.userId,
      sql`lower(${t.domain})`
    ),
    // Mongo's sparse `{verifiedDomains.domain}` index: "who claims this domain?"
    // Deliberately NOT unique — two accounts claiming one domain is a real
    // condition the platform must be able to observe and resolve, and Mongo
    // permitted it. Making it unique here would fail the backfill on data that
    // exists rather than surfacing it.
    index('user_verified_domains_lower_domain_idx').on(sql`lower(${t.domain})`),
    check(
      'user_verified_domains_method_check',
      sql`${t.method} in (${sql.raw(VERIFIED_DOMAIN_METHODS.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
