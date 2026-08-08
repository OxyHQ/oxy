/**
 * `app_updates` — one published Oxy Update for a single
 * `(channel, runtime_version, platform)`.
 *
 * Ported from `models/AppUpdate.ts`. The HEAD of a track is the newest
 * `published` row for `(application_id, channel_id, runtime_version, platform)`
 * ordered by `created_at`. Rolling back marks the head `rolled_back` — nothing
 * is deleted — so the previous published row becomes head again; promoting into
 * a channel inserts a NEW row (new `update_id`) pointing at the SAME assets.
 *
 * ## `update_id` is a UUIDv4, deliberately, and is NOT the primary key
 *
 * The expo-updates client PARSES the manifest `id` as a UUID, so this value must
 * stay one — it is the single place in this schema where the id format is a
 * client-visible contract rather than an internal choice, and it is why the
 * table's own `id` (uuid v7, per `CONVENTIONS.md`) is a separate column. The
 * CHECK states the requirement the client imposes: parseable as a UUID. It does
 * NOT pin the version, because a promoted or imported manifest id only has to
 * parse.
 *
 * ## `launch_asset` is columns, `assets[]` is a child table
 *
 * The launch asset is exactly one, always present, with a closed four-field
 * shape — real columns. `assets[]` is an ORDERED list of the same shape, so it
 * is `app_update_assets` with an explicit `ordinal`: the published manifest must
 * stay byte-identical for its whole life (it is signed, and a device may fetch
 * any historical update), and an unordered child table would let a re-read
 * reorder the array and invalidate the signature.
 *
 * Both carry a real foreign key to `update_assets.sha256`, which the Mongo model
 * deliberately did not — its reason was that the manifest must be servable
 * without a join, and that still holds: every descriptor the manifest needs is
 * stored locally, so the FK adds integrity without adding a read. It is
 * `RESTRICT`, so the bytes a published manifest names cannot be deleted out from
 * under it. Safe by construction: `assertAssetsUploaded`
 * (`publish.service.ts:251`) already refuses to publish an update whose assets
 * are not present and `uploaded`.
 *
 * ## `extra` and `metadata` are the only real `jsonb` here
 *
 * `extra` is an opaque blob embedded VERBATIM in the signed manifest — genuinely
 * shape-less, except for the one key the client cannot boot without, which the
 * Mongoose validator asserted and a CHECK now enforces at every write path
 * rather than only the ones that go through Mongoose. `metadata` is an
 * open-ended string dict filtered client-side.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { SHA256_HEX_PATTERN, updateAssets } from './updateAssets';
import { UPDATE_PLATFORMS, updateChannels } from './updateChannels';

/**
 * Publication state. `superseded` and `rolled_back` are retained, never deleted
 * — the previous head has to remain servable.
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 */
export const APP_UPDATE_STATUSES = ['published', 'superseded', 'rolled_back'] as const;

/**
 * Canonical UUID text form, case-insensitively. The expo-updates client parses
 * the manifest `id` as a UUID; anything else is a manifest no device can load.
 */
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const appUpdates = pgTable(
  'app_updates',
  {
    id: generatedId(),
    /**
     * The manifest `id` served to devices and the public handle promote/rollout
     * operations address. UUIDv4 on purpose — see the header.
     */
    updateId: text()
      .notNull()
      .$defaultFn(() => randomUUID()),
    /** `CASCADE` — updates for an application that no longer exists serve nobody. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** `CASCADE` — an update outside any channel is unreachable by every client. */
    channelId: text()
      .notNull()
      .references(() => updateChannels.id, { onDelete: 'cascade' }),
    runtimeVersion: text().notNull(),
    platform: text({ enum: UPDATE_PLATFORMS }).notNull(),
    status: text({ enum: APP_UPDATE_STATUSES }).notNull().default('published'),

    // ---- launch asset (flattened; exactly one, always present) -------------
    /** Content address of the launch bundle. `RESTRICT` — see the header. */
    launchAssetSha256: text()
      .notNull()
      .references(() => updateAssets.sha256, { onDelete: 'restrict' }),
    /** The expo-export asset key app code references the bundle by. */
    launchAssetKey: text().notNull(),
    launchAssetContentType: text().notNull(),
    /** With a leading dot. Absent for the launch asset in practice. */
    launchAssetFileExtension: text(),

    // ---- manifest payload --------------------------------------------------
    /** Embedded verbatim in the signed manifest. MUST carry `expoClient`. */
    extra: jsonb().$type<Record<string, unknown>>().notNull(),
    /** String→string manifest metadata dict, filtered client-side. */
    metadata: jsonb()
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Deterministic per-device bucketing at serve time. */
    rolloutPercent: integer().notNull().default(100),

    // ---- provenance --------------------------------------------------------
    gitCommit: text(),
    gitBranch: text(),
    message: text(),
    /**
     * When this row is a promotion, the `update_id` it was promoted FROM — a
     * SELF reference through the public handle rather than the primary key,
     * because that handle is what the admin API and the manifest speak.
     *
     * `SET NULL`: NULL already means "not a promotion", and nothing in this
     * system deletes an update, so the audit hop is only ever lost to a
     * deliberate purge.
     */
    promotedFromUpdateId: text().references((): AnyPgColumn => appUpdates.updateId, {
      onDelete: 'set null',
    }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('app_updates_update_id_key').on(t.updateId),
    // Head resolution: the newest published update for a channel + runtime +
    // platform (`resolveHead`, `manifest.service.ts`). Mongo's standalone
    // `{applicationId}` is dropped — a btree serves any leading prefix.
    index('app_updates_head_idx').on(
      t.applicationId,
      t.channelId,
      t.runtimeVersion,
      t.platform,
      t.status,
      t.createdAt.desc()
    ),
    // "This channel's updates", and the index Postgres needs to cascade a
    // channel delete without scanning the table — neither of which the compound
    // above can serve, since it leads with the application.
    index('app_updates_channel_id_idx').on(t.channelId),
    // Mongo's standalone `{status}` index is dropped: three values, almost every
    // row `published`, and every read that mentions status already carries the
    // channel + runtime + platform the compound above leads with.
    check(
      'app_updates_platform_check',
      sql`${t.platform} in (${sql.raw(inList(UPDATE_PLATFORMS))})`
    ),
    check(
      'app_updates_status_check',
      sql`${t.status} in (${sql.raw(inList(APP_UPDATE_STATUSES))})`
    ),
    check('app_updates_update_id_check', sql`${t.updateId} ~* ${sql.raw(`'${UUID_PATTERN}'`)}`),
    check(
      'app_updates_launch_asset_sha256_check',
      sql`${t.launchAssetSha256} ~ ${sql.raw(`'${SHA256_HEX_PATTERN}'`)}`
    ),
    check(
      'app_updates_rollout_percent_check',
      sql`${t.rolloutPercent} >= 0 and ${t.rolloutPercent} <= 100`
    ),
    // The Mongoose validator, now unbypassable: without `extra.expoClient` the
    // client's `Constants.expoConfig` does not resolve after an OTA update, so a
    // manifest missing it is one that breaks every device it reaches.
    //
    // `IS NOT DISTINCT FROM`, not `=`, and the difference is the whole
    // constraint: when the key is ABSENT, `->` yields SQL NULL, `jsonb_typeof`
    // of NULL is NULL, and `NULL = 'object'` is NULL — which a CHECK treats as
    // SATISFIED. The plain equality therefore fails OPEN on precisely the case
    // it exists to catch (measured: a row with no `expoClient` at all inserted
    // cleanly). `IS NOT DISTINCT FROM` compares NULL as a value, so absent, JSON
    // `null`, and a scalar are all rejected.
    check(
      'app_updates_extra_expo_client_check',
      sql`jsonb_typeof(${t.extra} -> 'expoClient') is not distinct from 'object'`
    ),
    // `metadata` is a dict, never a scalar or an array — the manifest builder
    // iterates its keys.
    check('app_updates_metadata_check', sql`jsonb_typeof(${t.metadata}) = 'object'`),
  ]
);
