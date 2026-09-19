/**
 * `email_suppressions` — addresses this platform must stop sending to.
 *
 * A bounce or a spam complaint is a message FROM the receiving side, and the
 * only thing that makes it useful is refusing to send again. Without this
 * table, a mistyped address is re-attempted on every compose, and the bounce
 * rate that Gmail, Outlook and the relay provider measure is the one that gets
 * a sending domain suspended — AWS suspends above ~5% bounces or ~0.1%
 * complaints. Provider-side suppression (SES has its own account list) is not a
 * substitute: it stops the delivery but the ATTEMPT still counts, and it tells
 * the sender nothing.
 *
 * ## Why `user_id` is nullable, and why that is the whole design
 *
 * The two reasons are not the same kind of fact:
 *
 *  - A **permanent bounce** is a property of the ADDRESS. `juan@empresa.com`
 *    does not exist for anybody, so the row is global (`user_id IS NULL`).
 *  - A **complaint** is a property of the PAIR. One account holder was marked
 *    as spam by that recipient; every other account holder on this platform is
 *    a different correspondent and must not be blocked. Those rows carry the
 *    `user_id` of the sender who was reported.
 *
 * Collapsing the two would either leak one user's reputation onto everyone
 * else's mail, or drop the global signal that actually protects the domain.
 *
 * The unique index is `NULLS NOT DISTINCT` so a second global row for the same
 * address collides instead of accumulating — Postgres's default would treat
 * every NULL `user_id` as distinct and let the table grow without bound.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

/**
 * Why an address is suppressed.
 *
 * `bounce_transient` exists so a full mailbox or a temporarily unreachable
 * server backs a sender off for a while WITHOUT becoming a permanent verdict;
 * those rows carry an `expires_at` and age out. `manual` is an operator or the
 * account holder deciding, and never expires on its own.
 */
export const EMAIL_SUPPRESSION_REASONS = [
  'bounce_permanent',
  'bounce_transient',
  'complaint',
  'manual',
] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

/** Who told us. `manual` means nobody did — a human decided. */
export const EMAIL_SUPPRESSION_SOURCES = ['ses', 'brevo', 'smtp', 'manual'] as const;
export type EmailSuppressionSource = (typeof EMAIL_SUPPRESSION_SOURCES)[number];

export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    id: generatedId(),
    /**
     * NULL = global (the address itself is bad). Non-null = scoped to the
     * account holder who was complained about. A deleted account takes its
     * scoped suppressions with it; the global ones are not its to own.
     */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** Always stored lower-cased; callers normalise before writing or reading. */
    address: text().notNull(),
    reason: text({ enum: EMAIL_SUPPRESSION_REASONS }).notNull(),
    source: text({ enum: EMAIL_SUPPRESSION_SOURCES }).notNull(),
    /**
     * The provider's own diagnostic, truncated. Kept so a user can be told WHY
     * their message is being refused — "mailbox does not exist" is actionable,
     * "suppressed" is not.
     */
    diagnostic: text(),
    reportedAt: timestamptz().notNull().defaultNow(),
    /** NULL = never expires. Set for `bounce_transient`. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('email_suppressions_scope_address_key')
      .on(t.userId, t.address)
      .nullsNotDistinct(),
    index('email_suppressions_address_idx').on(t.address),
    index('email_suppressions_expires_idx').on(t.expiresAt),
    check(
      'email_suppressions_reason_check',
      sql`${t.reason} in (${sql.raw(EMAIL_SUPPRESSION_REASONS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'email_suppressions_source_check',
      sql`${t.source} in (${sql.raw(EMAIL_SUPPRESSION_SOURCES.map((v) => `'${v}'`).join(', '))})`,
    ),
    // A complaint is always attributable to the sender who was reported; a
    // global complaint row would silently blocklist an address for everyone.
    check(
      'email_suppressions_complaint_is_scoped_check',
      sql`${t.reason} <> 'complaint' or ${t.userId} is not null`,
    ),
  ],
);
