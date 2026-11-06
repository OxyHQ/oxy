/**
 * `personal_identity_key_retirements` — every root a personal account replaced
 * by rotation (`POST /auth/rotate/complete`).
 *
 * The CURRENT root is the account's `users.public_key`; this table holds the
 * ones before it, written in the rotation's own transaction (`routes/authLinking.ts`,
 * the only writer). Commons keeps a rotated account's previous private keys so
 * the Peable wallet can still spend what they received, and reads this history
 * (`GET /identity/key-history`) to accept a previous recovery phrase only when
 * it derives a key that WAS this account's root.
 *
 * ## A retired root is never used again (ADR 0061 D2, applied to persons)
 *
 * Peable derives a person's FairCoin receive addresses from their root, so a
 * retired root that came back as another account's would hand that account the
 * address tree it used to receive into. `public_key` is unique, and every key
 * writer — personal sign-up, linking, rotation and the organization-key service
 * — refuses a key found here (`identityKeyEverUsed` /
 * `personalKeyEverRetired`). Deleting the account keeps its rows (`user_id`
 * becomes NULL, `SET NULL`) for the same reason: the key stays a tombstone.
 *
 * Append-only: a row is never updated, so it has `retired_at` and no
 * `updated_at`.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { users } from './users';

export const personalIdentityKeyRetirements = pgTable(
  'personal_identity_key_retirements',
  {
    id: generatedId(),
    /**
     * The person whose root this was. `SET NULL` — a deleted account's retired
     * roots stay as tombstones (see the header); NULL means "an account that no
     * longer exists", never "unassigned".
     */
    userId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Canonical: lowercase, uncompressed (`04` + 128 hex). */
    publicKey: text().notNull(),
    /** When a rotation replaced it. */
    retiredAt: createdAt(),
  },
  (t) => [
    unique('personal_identity_key_retirements_public_key_key').on(t.publicKey),
    // The history read, and the FK.
    index('personal_identity_key_retirements_user_id_idx').on(t.userId, t.retiredAt),
    check(
      'personal_identity_key_retirements_public_key_check',
      sql`${t.publicKey} ~ '^04[0-9a-f]{128}$'`,
    ),
  ],
);
