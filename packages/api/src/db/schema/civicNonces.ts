/**
 * `civic_nonces` — the single-use nonce store that makes a civic attestation
 * unreplayable.
 *
 * Ported from `models/CivicNonce.ts`. The nonce is minted client-side (embedded
 * in the QR the subject shows) and recorded here on FIRST use. The unique index
 * on `nonce_hash` is the whole mechanism: the first submission wins and every
 * replay fails on the constraint, so a counterparty cannot submit the same
 * signed attestation twice and a stolen envelope cannot be re-played. Only the
 * `sha256` is stored, never the raw nonce.
 *
 * ## Expiry — the retention IS the replay window
 *
 * Mongo TTL `expireAfterSeconds: 600` on `expiresAt`: the row deliberately
 * outlives its own deadline by ten minutes. Deleting it earlier would free the
 * hash for reuse, so this retention is a SECURITY parameter, not housekeeping —
 * shortening it reopens the replay window it exists to close. Registered in
 * `db/expiry.ts` with `retentionSeconds: 600`.
 *
 * `purpose` stays free-form `text`, as Mongoose declared it. It namespaces the
 * nonce so one raw value used by two flows cannot collide, and only one flow
 * exists today (`realLife.service.ts:89`) — inventing a CHECK from a
 * single-element set would reject the next flow at insert time for no benefit.
 *
 * Append-only: `timestamps: { createdAt: true, updatedAt: false }`, so there is
 * no `updated_at`. A consumed nonce is never rewritten.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

export const civicNonces = pgTable(
  'civic_nonces',
  {
    id: generatedId(),
    /** `sha256` of the raw nonce, salted by purpose at the call site. */
    nonceHash: text().notNull(),
    /** The civic flow this nonce belongs to, e.g. `real_life_attestation`. */
    purpose: text().notNull(),
    /**
     * The subject the nonce was issued about — the user being attested.
     * `CASCADE`: an attestation about a deleted account can never be submitted,
     * and the nonce's only remaining job would be to occupy its hash.
     */
    subjectUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('civic_nonces_nonce_hash_key').on(t.nonceHash),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('civic_nonces_expires_at_idx').on(t.expiresAt),
  ]
);
