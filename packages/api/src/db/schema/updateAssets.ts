/**
 * `update_assets` — a content-addressed Oxy Update asset.
 *
 * Ported from `models/UpdateAsset.ts`. Assets are keyed by the SHA-256 of their
 * bytes and shared across every update and application referencing the same
 * content, so an unchanged JS bundle or image is stored in S3 exactly once.
 *
 * The S3 object is IMMUTABLE: a client may fetch any historical update's assets
 * at any time (expo-updates spec, "Asset response"), so a URL for a given
 * content hash must never change or disappear. That is why every reference to
 * this table (`app_updates.launch_asset_sha256`, `app_update_assets.sha256`) is
 * `ON DELETE RESTRICT` — deleting an asset a published manifest names would make
 * that manifest unservable, and the database now refuses instead of finding out
 * from a device.
 *
 * ## `s3_key` is GENERATED
 *
 * `updateAssetS3Key(sha256)` (`services/updates/assetKeys.ts:16`) is a total
 * function of the hash, and both the publish service (which writes the object)
 * and the manifest service (which serves its URL) call it rather than reading
 * the stored column. A `GENERATED ALWAYS … STORED` column is the schema saying
 * so: no write path — route, service, backfill or `psql` — can produce a row
 * whose key disagrees with its content address, and an attempt to write it fails
 * with SQLSTATE `428C9`.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

/** Upload lifecycle. Only an `uploaded` asset may be referenced by a published update. */
export const UPDATE_ASSET_STATUSES = ['pending', 'uploaded'] as const;

/**
 * Lowercase-hex SHA-256. The same `/^[a-f0-9]{64}$/` the Mongoose `match`
 * enforced, and the shape the S3 key and CDN URL are derived from.
 */
export const SHA256_HEX_PATTERN = '^[a-f0-9]{64}$';

/**
 * S3 prefix every asset object lives under. Mirrors `UPDATE_ASSET_KEY_PREFIX`
 * (`services/updates/assetKeys.ts:13`), copied rather than imported because that
 * module pulls in `config/cdn`, which reads the environment at load time and
 * would then run inside `drizzle-kit generate`.
 * `__tests__/appUpdates.test.ts` holds the two equal.
 */
export const UPDATE_ASSET_KEY_PREFIX = 'public/updates/assets/';

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const updateAssets = pgTable(
  'update_assets',
  {
    id: generatedId(),
    /** The content address. Lowercase hex, and the dedup key across every application. */
    sha256: text().notNull(),
    /**
     * `public/updates/assets/<sha256>` — derived, never written. See the header.
     */
    s3Key: text()
      .notNull()
      .generatedAlwaysAs(sql.raw(`'${UPDATE_ASSET_KEY_PREFIX}' || sha256`)),
    /** MIME type declared at init (e.g. `application/javascript`). */
    contentType: text().notNull(),
    /**
     * Byte length, verified against S3 `HeadObject` at completion. `bigint`
     * rather than `integer`: a size in bytes is not bounded by 2 GiB by
     * anything in this system, and a silent overflow on a file size is the kind
     * of limit nobody remembers choosing.
     */
    size: bigint({ mode: 'number' }).notNull(),
    status: text({ enum: UPDATE_ASSET_STATUSES }).notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The content address is the real key: `findOne({sha256})` and
    // `find({sha256: {$in: […]}})` are the only reads, and this is also the
    // unique constraint the two referencing tables point at.
    unique('update_assets_sha256_key').on(t.sha256),
    // Mongo's `{status}` index is dropped: it has two values, almost every row
    // is `uploaded`, and the one query that mentions it
    // (`assertAssetsUploaded`, `publish.service.ts:253`) is already keyed on the
    // high-entropy `sha256` the unique above answers directly.
    check(
      'update_assets_status_check',
      sql`${t.status} in (${sql.raw(inList(UPDATE_ASSET_STATUSES))})`
    ),
    check(
      'update_assets_sha256_check',
      sql`${t.sha256} ~ ${sql.raw(`'${SHA256_HEX_PATTERN}'`)}`
    ),
    check('update_assets_size_check', sql`${t.size} >= 0`),
  ]
);
