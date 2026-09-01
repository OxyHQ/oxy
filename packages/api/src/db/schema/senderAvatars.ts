/**
 * `sender_avatars` — the resolved avatar for an email address, cached.
 *
 * Ported from `models/SenderAvatar.ts`. Global, not per user: the answer to
 * "what does mail from this address look like" is the same for everyone.
 *
 * ## The TTL, and the read that depended on it
 *
 * Mongo declared the TTL as a FIELD option rather than a `schema.index()` call —
 * `expiresAt: { type: Date, required: true, index: { expires: 0 } }` — which is
 * easy to miss and is a real TTL index all the same. It becomes an entry in
 * `EXPIRY_SWEEP_TARGETS` (`db/expiry.ts`) plus the btree the sweep's range scan
 * requires.
 *
 * This is the table `CONVENTIONS.md` names as its class-(B) example: both reads
 * (`senderAvatar.service.ts:179` and `:208`) return the cached row with NO
 * expiry predicate and no application-side check, so today the only thing that
 * stops a stale avatar being served is Mongo's TTL monitor having got there
 * first. That makes a background job part of the table's CORRECTNESS, and the
 * staleness window is whatever the job's interval happens to be.
 *
 * {@link senderAvatarIsFresh} is the read-side filter that moves both into
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
import { generatedId, timestamptz } from '@oxyhq/db';

/** Where the avatar came from. `none` records a resolved absence, so it caches too. */
export const SENDER_AVATAR_SOURCES = ['oxy', 'bimi', 'gravatar', 'favicon', 'none'] as const;

export const senderAvatars = pgTable(
  'sender_avatars',
  {
    id: generatedId(),
    /**
     * The address this row answers for.
     *
     * CALL-SITE OBLIGATION: Mongoose stored it `lowercase: true, trim: true`.
     * `senderAvatar.service.ts` already normalizes before every read and write
     * (`email.trim().toLowerCase()`), which is what must continue — a write
     * that skips it creates a second cache row that no read will ever find.
     */
    email: text().notNull(),
    /** Relative path to the image, or NULL when no avatar could be resolved. */
    avatarPath: text(),
    source: text({ enum: SENDER_AVATAR_SOURCES }).notNull(),
    /**
     * When the lookup ran. Mongo declared `timestamps: false` and this field
     * instead; it is the row's birth column under a domain name, so it keeps
     * that name and there is no `created_at`/`updated_at` pair to invent.
     */
    resolvedAt: timestamptz().notNull().defaultNow(),
    /** After this instant the row is stale. See the module comment. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex('sender_avatars_email_key').on(t.email),
    // Required by every `EXPIRY_SWEEP_TARGETS` entry: the sweep's predicate is a
    // range scan, and Mongo's TTL index carried the same obligation.
    index('sender_avatars_expires_at_idx').on(t.expiresAt),
    check(
      'sender_avatars_source_check',
      sql`${t.source} in (${sql.raw(
        SENDER_AVATAR_SOURCES.map((value) => `'${value}'`).join(', ')
      )})`
    ),
  ]
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
