/**
 * `identity_web_envelopes` — the sealed web copy of an account's identity.
 *
 * "One identity, two carriers" (`docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`):
 * a browser carries the account's self-custody identity as an envelope whose
 * mnemonic entropy is sealed under a data key, and the data key is wrapped once
 * per passkey under a key only that passkey's WebAuthn PRF output can derive.
 * The PRF output never leaves the user's authenticator and the mnemonic is never
 * uploaded, so this row is ciphertext the server cannot open — the same
 * non-custodial property as `identity_backups`.
 *
 * Why a server copy exists at all (design decision D1): Safari deletes a site's
 * IndexedDB after seven days without first-party interaction, and people use
 * the apps, not the identity origin. A local-only envelope would be wiped.
 *
 * One envelope per account. It always carries the account's CURRENT identity
 * key: writes are refused unless `public_key` equals `users.public_key`, and a
 * read of an envelope whose key no longer matches (the identity was rotated or
 * moved) returns nothing.
 */

import { index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import type { WebIdentityWrap } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const identityWebEnvelopes = pgTable(
  'identity_web_envelopes',
  {
    id: generatedId(),
    /** `CASCADE` — the sealed identity of a deleted account must not outlive it. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The identity public key the envelope seals, lowercase uncompressed hex. Bound into every AEAD. */
    publicKey: text().notNull(),
    /** Envelope scheme version (`WEB_IDENTITY_ENVELOPE_VERSION`). */
    version: integer().notNull(),
    /** The AEAD that sealed the envelope, `xchacha20poly1305`. */
    algorithm: text().notNull(),
    /** 24-byte nonce of the entropy seal, hex. */
    entropyNonce: text().notNull(),
    /** The BIP-39 entropy sealed under the data key, tag appended, hex. Undecryptable here. */
    sealedEntropy: text().notNull(),
    /** One data-key wrap per passkey (`WebIdentityWrap[]`). Undecryptable here. */
    wraps: jsonb().$type<WebIdentityWrap[]>().notNull(),
    /**
     * When the owner proved (with the identity key) that the recovery phrase is
     * written down, or `null`. Until then the identity is not unlocked on a
     * second device nor used for key operations (design decision D2).
     */
    phraseConfirmedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_web_envelopes_user_id_key').on(t.userId),
    index('identity_web_envelopes_public_key_idx').on(t.publicKey),
  ],
);
