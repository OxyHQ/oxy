/**
 * `identity_link_requests` — the relay for linking Commons to an account that
 * has no key yet (ADR 0029 D3, ADR 0030).
 *
 * The signed-in app opens one for its account; Commons, on another device,
 * posts the root proof it signed over the request's challenge; the app
 * completes it with a code just sent to the account's email, in the
 * transaction that links the root (`services/identityLink.service.ts`).
 *
 * The challenge itself is never stored: `challenge_hash` is its SHA-256, and
 * the challenge is burned by the proof's own `identity_proof_challenges` row.
 * `link_id` is a random 128-bit capability carried in the QR — the public
 * handle of this row, not a reference to another. Every read and transition
 * filters `expires_at` itself; the sweep in `db/expiry.ts` only reclaims
 * storage, an hour late, so a late poll is told "expired" rather than "unknown".
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { IDENTITY_LINK_STATUSES, type IdentityProof } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const identityLinkRequests = pgTable(
  'identity_link_requests',
  {
    id: generatedId(),
    linkId: text().notNull(),
    /** The account being linked. `CASCADE`: nothing to link once it is gone. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the `link_identity` proof challenge the QR carries. */
    challengeHash: text().notNull(),
    status: text({ enum: IDENTITY_LINK_STATUSES }).notNull().default('pending'),
    /** The key Commons signed with, once it has (lowercase, uncompressed). */
    publicKey: text(),
    /** The root proof Commons signed, as it travels. Public: a signature, a challenge, an expiry. */
    proof: jsonb().$type<IdentityProof>(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_link_requests_link_id_key').on(t.linkId),
    index('identity_link_requests_user_id_idx').on(t.userId),
    index('identity_link_requests_expires_at_idx').on(t.expiresAt),
    check('identity_link_requests_status_check', sql`${t.status} in ('pending', 'signed', 'completed', 'cancelled')`),
    check('identity_link_requests_signed_check', sql`(${t.publicKey} is null) = (${t.proof} is null)`),
    check('identity_link_requests_link_id_check', sql`${t.linkId} ~ '^[0-9a-f]{32}$'`),
    check('identity_link_requests_challenge_hash_check', sql`${t.challengeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
