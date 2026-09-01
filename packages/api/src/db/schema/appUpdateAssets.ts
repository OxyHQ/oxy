/**
 * `app_update_assets` — one asset descriptor of a published update's manifest,
 * at a fixed position.
 *
 * Ported from the `assets[]` array embedded in `models/AppUpdate.ts`.
 *
 * ## The ordinal is the point
 *
 * The manifest is SIGNED and a device may fetch any historical update, so the
 * bytes a given `update_id` produces must be identical forever. A child table
 * without an explicit position would let a re-read return the same descriptors
 * in a different order, changing those bytes and invalidating the signature —
 * a failure that appears only on a device, only sometimes, and never in a test
 * that inserts a single row. `ordinal` makes the order data rather than a
 * property of the plan, and `(app_update_id, ordinal)` is therefore the natural
 * key and the PRIMARY KEY: no surrogate id is invented for a row nothing
 * references.
 *
 * `sha256` carries a real foreign key to `update_assets`, `ON DELETE RESTRICT`
 * — the bytes a published manifest names must not be deletable. See
 * `app_updates.ts` for why that costs the manifest path nothing.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { appUpdates } from './appUpdates';
import { SHA256_HEX_PATTERN, updateAssets } from './updateAssets';

export const appUpdateAssets = pgTable(
  'app_update_assets',
  {
    /** `CASCADE` — a descriptor without its manifest is unreachable. */
    appUpdateId: text()
      .notNull()
      .references(() => appUpdates.id, { onDelete: 'cascade' }),
    /** Zero-based position in the manifest's `assets` array. */
    ordinal: integer().notNull(),
    /** Content address — yields the CDN URL and the manifest integrity hash. */
    sha256: text()
      .notNull()
      .references(() => updateAssets.sha256, { onDelete: 'restrict' }),
    /**
     * The expo-export asset key: the md5 basename app code references an asset
     * by, and the value the client matches to SKIP an asset already embedded in
     * its binary.
     */
    key: text().notNull(),
    contentType: text().notNull(),
    /** With a leading dot. Omitted for an asset that has none. */
    fileExtension: text(),
  },
  (t) => [
    primaryKey({
      columns: [t.appUpdateId, t.ordinal],
      name: 'app_update_assets_pkey',
    }),
    // "Which manifests reference these bytes" — the fan-in the content-addressed
    // store exists for, and the index that stops an asset delete (RESTRICT) from
    // scanning the table to find out whether it may proceed.
    index('app_update_assets_sha256_idx').on(t.sha256),
    check('app_update_assets_ordinal_check', sql`${t.ordinal} >= 0`),
    check(
      'app_update_assets_sha256_check',
      sql`${t.sha256} ~ ${sql.raw(`'${SHA256_HEX_PATTERN}'`)}`
    ),
  ]
);
