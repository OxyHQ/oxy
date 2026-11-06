/**
 * `organization_identity_keys` — every identity key an organization has had
 * (ADR 0061).
 *
 * The CURRENT key is also the organization's `users.public_key`, which is what
 * the DID publishes as `#key-1` and what the global key index keeps unique. This
 * table is the history beside it: who linked each key, how, whether a
 * replacement was also signed by the key it replaced, and when it was retired.
 * Both are written in the one transaction of
 * `services/organizationIdentityKey.service.ts`, the only writer.
 *
 * ## A key is never used twice
 *
 * Peable derives an organization's FairCoin receive addresses from its key, so
 * a key that came back as another account's would hand that account the
 * organization's address tree. `public_key` is unique across every row, retired
 * ones included, and the personal key writers refuse a key found here
 * (`identityKeyEverUsed`, which also covers a person's retired roots,
 * `personal_identity_key_retirements`). Deleting the organization keeps its rows
 * (`account_id` becomes NULL, `SET NULL`) for the same reason: the key stays a
 * tombstone.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { ORGANIZATION_KEY_OPERATIONS } from '@oxy.so/contracts';
import { users } from './users';

export const organizationIdentityKeys = pgTable(
  'organization_identity_keys',
  {
    id: generatedId(),
    /**
     * The organization. `SET NULL` — a deleted organization's keys stay as
     * tombstones (see the header); NULL means "an organization that no longer
     * exists", never "unassigned".
     */
    accountId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Canonical: lowercase, uncompressed (`04` + 128 hex). */
    publicKey: text().notNull(),
    /** How the key arrived: the first key, or a replacement. */
    method: text({ enum: ORGANIZATION_KEY_OPERATIONS }).notNull(),
    /** The owner or admin who linked it. Attribution: `SET NULL` when their account goes. */
    linkedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** A replacement also signed by the key it replaced. Always false for `create`. */
    previousKeyProven: boolean().notNull().default(false),
    linkedAt: createdAt(),
    /** When a replacement took its place; NULL while it is the organization's key. */
    retiredAt: timestamptz(),
  },
  (t) => [
    unique('organization_identity_keys_public_key_key').on(t.publicKey),
    // At most one current key per organization.
    uniqueIndex('organization_identity_keys_current_key')
      .on(t.accountId)
      .where(sql`${t.retiredAt} is null`),
    // The history read, and the FK.
    index('organization_identity_keys_account_id_idx').on(t.accountId, t.linkedAt),
    index('organization_identity_keys_linked_by_user_id_idx').on(t.linkedByUserId),
    check(
      'organization_identity_keys_method_check',
      sql`${t.method} in (${sql.raw(ORGANIZATION_KEY_OPERATIONS.map((value) => `'${value}'`).join(', '))})`,
    ),
    check('organization_identity_keys_public_key_check', sql`${t.publicKey} ~ '^04[0-9a-f]{128}$'`),
    check(
      'organization_identity_keys_previous_key_proven_check',
      sql`${t.method} = 'replace' or not ${t.previousKeyProven}`,
    ),
  ],
);
