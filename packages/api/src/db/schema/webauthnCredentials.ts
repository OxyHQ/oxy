/**
 * `webauthn_credentials` — one registered WebAuthn/passkey credential.
 *
 * Ported from `models/WebauthnCredential.ts`; see that file for what
 * `counter`, `userVerified` and `deviceType` mean.
 *
 * Append-only timestamps: Mongoose declared `{ createdAt: true, updatedAt: false }`,
 * so there is no `updated_at` column here. Its ABSENCE is the contract — a
 * column nothing maintains would be worse than none. `last_used_at` is a
 * distinct, meaningful field and is still written on every successful assertion.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { bytea, createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

/** Whether the credential is bound to one authenticator or syncs across devices. */
export const WEBAUTHN_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: generatedId(),
    /** A passkey with no account behind it can never be asserted. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Browser-supplied base64url credential id. A public handle, not a secret. */
    credentialID: text().notNull(),
    /** COSE-encoded public key bytes, fed back to `verifyAuthenticationResponse`. */
    credentialPublicKey: bytea().notNull(),
    /**
     * The authenticator's signature counter. `bigint` rather than `integer`
     * because the WebAuthn spec types this as a uint32, whose upper half does
     * not fit in Postgres's signed `integer`.
     */
    counter: bigint({ mode: 'number' }).notNull().default(0),
    /**
     * Authenticator transport hints (`usb`, `nfc`, `internal`, …). A scalar
     * array of at most a handful of values, never queried by element, so a
     * native `text[]` rather than a child table. NULL means "the authenticator
     * gave no hint" — distinct from an empty list, which is why there is no
     * `'{}'` default.
     */
    transports: text().array(),
    deviceType: text({ enum: WEBAUTHN_DEVICE_TYPES }).notNull(),
    backedUp: boolean().notNull().default(false),
    userVerified: boolean().notNull().default(false),
    /** User-supplied nickname for the credential. */
    name: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz(),
  },
  (t) => [
    unique('webauthn_credentials_credential_id_key').on(t.credentialID),
    index('webauthn_credentials_user_id_idx').on(t.userId),
    check(
      'webauthn_credentials_device_type_check',
      sql`${t.deviceType} in ('singleDevice', 'multiDevice')`
    ),
  ]
);
