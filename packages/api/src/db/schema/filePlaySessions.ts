/**
 * `file_play_sessions` — one revocable play of one file's HLS ladder by an
 * application (ADR 0043 stage 4c).
 *
 * `POST /assets/service/streams` opens one for a file the calling application
 * owns or may read (`fileReference.service.mayApplicationRead`) and answers
 * signed URLs under `/assets/streams/<sessionId>.<secret>/…`: the master
 * playlist, its renditions, their segments, the AES-128 key, an audio file's
 * preview and waveform. Every one of those requests is checked against this
 * row (through a short per-task cache that the stage-4b cross-task file-cache
 * channel invalidates), so `DELETE /assets/service/streams/:id` — or the owner
 * revoking the application's access, or the file leaving `active` — stops the
 * play at once, not when a URL expires.
 *
 * Only the SHA-256 of the URL secret is stored. With `encryption = 'aes-128'`
 * the segments are encrypted as they are served, under a key of THIS session
 * (sealed with `secretBox`, context `play-session-key|<id>`): a leaked key opens
 * one session's segments, which the session gate already refuses once revoked.
 * With `key_authorization = 'webhook'` the key is released only after the
 * application's verified file-events endpoint answers `{ allow: true }` — the
 * product's own entitlement check.
 *
 * `renditions` is the session's allow-list of the ladder's rungs (`hls_a64`,
 * `hls_720p`…), or NULL for the whole ladder: a product that caps a listener's
 * quality (a free tier, data saver) opens the session with the rungs that
 * listener may play, and every request for any other rung — its playlist, its
 * segments, its key — is refused, not merely left out of the master.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { files } from './files';
import { users } from './users';

export const PLAY_SESSION_ENCRYPTIONS = ['aes-128', 'none'] as const;
export type PlaySessionEncryption = (typeof PLAY_SESSION_ENCRYPTIONS)[number];

export const PLAY_SESSION_KEY_AUTHORIZATIONS = ['none', 'webhook'] as const;
export type PlaySessionKeyAuthorization = (typeof PLAY_SESSION_KEY_AUTHORIZATIONS)[number];

/** Who ended a session early: the application, the file's owner, or Oxy (the file left `active`). */
export const PLAY_SESSION_REVOKERS = ['application', 'owner', 'oxy'] as const;
export type PlaySessionRevoker = (typeof PLAY_SESSION_REVOKERS)[number];

/**
 * Every rung a ladder can have: the audio ladder (`audioRenditions.ts`) and
 * the video one (`variantService`'s HLS configs). A session's allow-list
 * names only these.
 */
export const PLAY_SESSION_RENDITIONS = [
  'hls_a64',
  'hls_a128',
  'hls_a256',
  'hls_360p',
  'hls_720p',
  'hls_1080p',
] as const;
export type PlaySessionRendition = (typeof PLAY_SESSION_RENDITIONS)[number];

/** A session row is kept a day past its expiry, so a late read answers "expired". */
export const PLAY_SESSION_RETENTION_SECONDS = 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const filePlaySessions = pgTable(
  'file_play_sessions',
  {
    id: generatedId(),
    /** `CASCADE`: a play of a file that no longer exists is meaningless. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** The application that opened the session and alone may read or revoke it. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * The person the application opened it for, when it said so: recorded,
     * handed to its key-authorization check, and the handle of `POST
     * /assets/service/streams/revoke { endUserId }`. `CASCADE` with the account.
     */
    endUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the URL secret; the secret itself is never stored. */
    tokenSha256: text().notNull(),
    encryption: text({ enum: PLAY_SESSION_ENCRYPTIONS }).notNull(),
    keyAuthorization: text({ enum: PLAY_SESSION_KEY_AUTHORIZATIONS }).notNull(),
    /** The session's AES-128 content key, sealed; set exactly when `encryption = 'aes-128'`. */
    contentKeyCiphertext: text(),
    /**
     * The rungs this session may serve (a subset of {@link PLAY_SESSION_RENDITIONS},
     * sorted, distinct), or NULL for every rung of the ladder.
     */
    renditions: text({ enum: PLAY_SESSION_RENDITIONS }).array(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    revokedBy: text({ enum: PLAY_SESSION_REVOKERS }),
    createdAt: createdAt(),
  },
  (t) => [
    index('file_play_sessions_file_id_application_id_idx').on(t.fileId, t.applicationId),
    index('file_play_sessions_application_id_end_user_id_idx').on(t.applicationId, t.endUserId),
    index('file_play_sessions_end_user_id_idx').on(t.endUserId),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('file_play_sessions_expires_at_idx').on(t.expiresAt),
    check(
      'file_play_sessions_encryption_check',
      sql`${t.encryption} in (${sql.raw(inList(PLAY_SESSION_ENCRYPTIONS))})`,
    ),
    check(
      'file_play_sessions_key_authorization_check',
      sql`${t.keyAuthorization} in (${sql.raw(inList(PLAY_SESSION_KEY_AUTHORIZATIONS))})`,
    ),
    check(
      'file_play_sessions_revoked_by_check',
      sql`${t.revokedBy} is null or ${t.revokedBy} in (${sql.raw(inList(PLAY_SESSION_REVOKERS))})`,
    ),
    check(
      'file_play_sessions_revoked_check',
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
    check(
      'file_play_sessions_key_check',
      sql`(${t.encryption} = 'aes-128') = (${t.contentKeyCiphertext} is not null)`,
    ),
    check(
      'file_play_sessions_key_authorization_needs_key_check',
      sql`${t.keyAuthorization} = 'none' or ${t.encryption} = 'aes-128'`,
    ),
    check(
      'file_play_sessions_renditions_check',
      sql`${t.renditions} is null or (cardinality(${t.renditions}) >= 1 and ${t.renditions} <@ array[${sql.raw(inList(PLAY_SESSION_RENDITIONS))}]::text[])`,
    ),
    check('file_play_sessions_token_check', sql`${t.tokenSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type FilePlaySessionRow = typeof filePlaySessions.$inferSelect;
