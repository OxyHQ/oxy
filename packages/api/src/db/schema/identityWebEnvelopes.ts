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

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { WEB_IDENTITY_SECRET_KINDS, type WebIdentityWrap } from '@oxy.so/contracts';
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
    /**
     * What a version-2 envelope seals (`mnemonic-entropy` | `raw-private-key`);
     * `null` for version 1, which only ever sealed 12-word entropy.
     */
    secretKind: text({ enum: WEB_IDENTITY_SECRET_KINDS }),
    /** 24-byte nonce of the secret seal, hex (`entropyNonce` in v1, `secretNonce` in v2). */
    entropyNonce: text().notNull(),
    /** The secret sealed under the data key, tag appended, hex (`sealedEntropy` / `sealedSecret`). Undecryptable here. */
    sealedEntropy: text().notNull(),
    /** One data-key wrap per passkey (`WebIdentityWrap[]`). Undecryptable here. */
    wraps: jsonb().$type<WebIdentityWrap[]>().notNull(),
    /**
     * When the owner proved (with the identity key) that the recovery phrase is
     * written down, or `null`. A reminder input only (ADR 0024 D5): it does not
     * prove the material re-derives the root — `recoveryVerifiedAt` does.
     */
    phraseConfirmedAt: timestamptz(),
    /** When the recovery material was shown to re-derive this root (ADR 0024 D5), or `null`. */
    recoveryVerifiedAt: timestamptz(),
    /**
     * Compare-and-swap counter. Every write names the revision it replaces and
     * increments it, so two concurrent holder changes cannot silently drop one
     * another's wrap.
     */
    revision: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_web_envelopes_user_id_key').on(t.userId),
    index('identity_web_envelopes_public_key_idx').on(t.publicKey),
    check('identity_web_envelopes_revision_check', sql`${t.revision} >= 1`),
  ],
);
