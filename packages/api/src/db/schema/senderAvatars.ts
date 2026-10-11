/**
 * `sender_avatars` — the resolved avatar for an email address, cached.
 *
 * Ported from `models/SenderAvatar.ts`. Global, not per user: the answer to
 * "what does mail from this address look like" is the same for everyone.
 *
 * ## Expiry, and the read that must not depend on it
 *
 * `expires_at` is a deadline: the table is an entry in `EXPIRY_SWEEP_TARGETS`
 * (`db/expiry.ts`) plus the btree the sweep's range scan requires.
 *
 * A read that returned the cached row with NO expiry predicate would make the
 * sweep part of the table's CORRECTNESS, with a staleness window of whatever
 * the job's interval happens to be (class (B) in `CONVENTIONS.md`).
 *
 * {@link senderAvatarIsFresh} is the read-side filter that keeps every read in
 * class (A). With it, the sweep is pure housekeeping — an expired row still
 * present is simply not returned — and no table's correctness depends on a job
 * running:
 *
 * ```ts
 * db.select(...).from(senderAvatars)
 *   .where(and(eq(senderAvatars.email, normalized), senderAvatarIsFresh()));
 * ```
 *
 * A miss then falls through to the existing resolve-and-upsert path, which is
 * what an expired row was always supposed to cause.
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxy.so/db';

/** Where the avatar came from. `none` records a resolved absence, so it caches too. */
export const SENDER_AVATAR_SOURCES = ['oxy', 'bimi', 'gravatar', 'favicon', 'none'] as const;

export const senderAvatars = pgTable(
  'sender_avatars',
  {
    id: generatedId(),
    /**
     * The address this row answers for.
     *
     * CALL-SITE OBLIGATION: stored lower-cased and trimmed.
     * `senderAvatar.service.ts` normalizes before every read and write
     * (`email.trim().toLowerCase()`), which is what must continue — a write
     * that skips it creates a second cache row that no read will ever find.
     */
    email: text().notNull(),
    /** Relative path to the image, or NULL when no avatar could be resolved. */
    avatarPath: text(),
    source: text({ enum: SENDER_AVATAR_SOURCES }).notNull(),
    /**
     * When the lookup ran. It is the row's birth column under a domain name,
     * so there is no `created_at`/`updated_at` pair to invent.
     */
    resolvedAt: timestamptz().notNull().defaultNow(),
    /** After this instant the row is stale. See the module comment. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex('sender_avatars_email_key').on(t.email),
    // Required by every `EXPIRY_SWEEP_TARGETS` entry: the sweep's predicate is a
    // range scan.
    index('sender_avatars_expires_at_idx').on(t.expiresAt),
    check(
      'sender_avatars_source_check',
      sql`${t.source} in (${sql.raw(
        SENDER_AVATAR_SOURCES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
  ],
);

/**
 * `expires_at > now()` — the predicate every read of this table must carry.
 *
 * Exported rather than written out at each call site because it is the whole
 * difference between the sweep being housekeeping and the sweep being the only
 * thing keeping a stale avatar off a user's screen. Two reads need it and both
 * currently lack it.
 */
export function senderAvatarIsFresh(): SQL {
  return sql`${senderAvatars.expiresAt} > now()`;
}
