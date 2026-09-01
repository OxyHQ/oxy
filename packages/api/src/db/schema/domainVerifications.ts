/**
 * `domain_verifications` — a PENDING custom-domain ownership challenge.
 *
 * Ported from `models/DomainVerification.ts`. The table only ever holds
 * in-flight challenges: once ownership is proven the domain is written to
 * `user_verified_domains` and this row is DELETED (`identity.ts:476`).
 *
 * ## Two Mongoose fields do not travel
 *
 * Both were verified dead against every call site before being dropped, not
 * assumed:
 *
 * - **`status`** (`enum: ['pending']`, `default: 'pending'`) — written as the
 *   literal `'pending'` at `identity.ts:389` and read by nothing, anywhere. A
 *   column whose value set has one member and whose value nobody consults
 *   carries no information; the row's EXISTENCE is the pending state, which is
 *   what the model's own comment says.
 * - **`method`** — documented as "set at verify time", but the verify path
 *   (`identity.ts:447-476`) writes the method onto `user_verified_domains` and
 *   then deletes this row, so it is never set. The only other mention is the
 *   `$unset` at `identity.ts:389`, which clears a field nothing ever wrote.
 *   `user_verified_domains.method` is where that value actually lives.
 *
 * ## Expiry
 *
 * Mongo TTL `expireAfterSeconds: 0` on `expiresAt`; registered in `db/expiry.ts`
 * with `retentionSeconds: 0`. Housekeeping only — `identity.ts:439` compares
 * `expiresAt` against now itself and refuses a stale challenge.
 *
 * Append-only timestamps: Mongoose declared
 * `timestamps: { createdAt: true, updatedAt: false }`, so there is no
 * `updated_at`. Re-requesting a challenge upserts a fresh `token` and
 * `expires_at` over the same row, and `expires_at` is what says when it was last
 * issued.
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

export const domainVerifications = pgTable(
  'domain_verifications',
  {
    id: generatedId(),
    /** `CASCADE` — a challenge for a deleted account can never be completed. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Mongoose stored this `lowercase: true` + `trim: true`; re-apply at the call site. */
    domain: text().notNull(),
    /**
     * The challenge value the owner publishes in DNS-TXT or `/.well-known`.
     * Public by construction — it exists to be broadcast — so it is not a
     * protected column.
     */
    token: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // One in-flight challenge per (user, domain). On `lower(domain)` for the
    // same reason `user_verified_domains` is: Mongoose's `lowercase: true`
    // setter has no Postgres counterpart, and a call site that forgets it would
    // otherwise open a SECOND live challenge for the same domain — two valid
    // tokens where the model promises one.
    uniqueIndex('domain_verifications_user_id_lower_domain_key').on(
      t.userId,
      sql`lower(${t.domain})`
    ),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('domain_verifications_expires_at_idx').on(t.expiresAt),
    // Mongo's field-level `{userId: 1}` is dropped: the compound unique above
    // leads with `user_id`, and a btree serves any leading prefix.
  ]
);
