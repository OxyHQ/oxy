/**
 * `identity_backups` — one encrypted, off-device identity backup per account.
 *
 * Ported from `models/IdentityBackup.ts`. Zero-knowledge at rest: the server
 * stores opaque ciphertext plus `sha256(lookupId)` and never sees the recovery
 * phrase, the derived key, the private key, or the raw `lookupId`. It can
 * therefore neither LOCATE a backup (it lacks the seed to compute a locator) nor
 * DECRYPT one.
 *
 * ## Two timestamps that are not the same thing
 *
 * Mongoose declared `timestamps: { createdAt: false, updatedAt: true }` and then
 * REDECLARED `createdAt` as a **String** holding the client's ISO-8601 snapshot
 * time, stored verbatim so the public restore endpoint can hand back the exact
 * envelope that was uploaded. Two different values were sharing one name. Here
 * they do not:
 *
 * - `client_created_at` — `text`, the client's value, byte for byte. NOT a
 *   `timestamptz`: parsing it would re-render it on read in a different string
 *   form, and the restore endpoint's contract is to return what was uploaded.
 * - `updated_at` — the row's last write, as Mongoose maintained it.
 *
 * There is deliberately NO `created_at`. Mongoose's `createdAt: false` was
 * forced by the name collision above, so the row's birth was never recorded, and
 * a `DEFAULT now()` column would stamp every backfilled row with the migration
 * date — asserting, of every backup that already exists, a falsehood. The
 * snapshot time is `client_created_at`; the last write is `updated_at`.
 */

import { integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const identityBackups = pgTable(
  'identity_backups',
  {
    id: generatedId(),
    /** One backup per account. `CASCADE` — a backup of a deleted account is dead weight. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `sha256(lookupId)`. The public restore endpoint hashes the client-supplied
     * raw locator and matches on this; the raw value is never stored, so
     * possession of the 256-bit locator — which requires the full seed to
     * compute — is the only way to fetch a backup.
     */
    lookupIdHash: text().notNull(),
    /** Short public-key prefix, so the owner can recognise which identity this is. */
    publicKeyHint: text().notNull(),
    /** XChaCha20-Poly1305 ciphertext with appended tag, hex. Undecryptable here. */
    ciphertext: text().notNull(),
    /** The 24-byte AEAD nonce, hex. */
    nonce: text().notNull(),
    /** The AEAD that sealed the ciphertext, e.g. `xchacha20poly1305`. */
    algorithm: text().notNull(),
    /** The HKDF `info` label used to derive the key — the domain-separation tag. */
    kdfInfo: text().notNull(),
    /** Envelope/KDF version, so a future scheme migration is distinguishable at rest. */
    version: integer().notNull(),
    /** The client's ISO-8601 snapshot timestamp, verbatim. See the header. */
    clientCreatedAt: text().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_backups_user_id_key').on(t.userId),
    unique('identity_backups_lookup_id_hash_key').on(t.lookupIdHash),
  ]
);
