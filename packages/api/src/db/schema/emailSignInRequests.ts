/**
 * `email_signin_requests` — signing in with the code or the link one email
 * carries (`services/emailSignIn.service.ts`).
 *
 * One row per `POST /auth/signin/email/start`. Its code is the
 * `email_verifications` row it names (purpose `signin`), which already counts
 * wrong attempts, expires and is rate-limited per address; this row adds what
 * the link and the dialog need:
 *
 * - `request_secret_hash`: SHA-256 of the secret only the dialog that asked
 *   holds. Confirming the code and collecting a link approval both need it, so
 *   the session goes to the dialog, never to whoever opens the link.
 * - `link_token_hash`: SHA-256 of the email link's one-use token.
 * - `requester_device_id`: the device the dialog PROVED at start (the browser's
 *   shared one), or null. The link approves only when auth.oxy.so proves the
 *   same device — the same browser. Null means the link cannot approve at all.
 *
 * A row with no `user_id` is a decoy: nobody was sent anything, and it can never
 * be approved or confirmed. `expires_at` is the row's deadline (the link's,
 * the later one); every read filters it, the sweep only reclaims storage.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { emailVerifications } from './emailVerifications';
import { users } from './users';

export const emailSignInRequests = pgTable(
  'email_signin_requests',
  {
    id: generatedId(),
    /** The code's row. `CASCADE`: a request without its code is nothing. */
    verificationId: text()
      .notNull()
      .references(() => emailVerifications.id, { onDelete: 'cascade' }),
    /** The account signing in; `null` for a decoy. */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    requestSecretHash: text().notNull(),
    linkTokenHash: text().notNull(),
    requesterDeviceId: text(),
    /** When the link was opened in the requester's browser. */
    approvedAt: timestamptz(),
    /** When a session (or a second-factor challenge) was issued for it: spent. */
    completedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('email_signin_requests_verification_id_key').on(t.verificationId),
    unique('email_signin_requests_link_token_hash_key').on(t.linkTokenHash),
    index('email_signin_requests_user_id_idx').on(t.userId),
    index('email_signin_requests_expires_at_idx').on(t.expiresAt),
    check('email_signin_requests_secret_hash_check', sql`${t.requestSecretHash} ~ '^[0-9a-f]{64}$'`),
    check('email_signin_requests_link_hash_check', sql`${t.linkTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('email_signin_requests_approved_check', sql`${t.approvedAt} is null or ${t.userId} is not null`),
  ],
);
