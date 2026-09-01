/**
 * `files` — one stored asset in the Oxy file manager.
 *
 * Ported from `models/File.ts`.
 *
 * ## The first PARTIAL UNIQUE in this schema
 *
 * Mongo:
 *
 * ```js
 * FileSchema.index({ sha256: 1 }, {
 *   unique: true,
 *   partialFilterExpression: { status: { $in: ['active', 'trash'] } },
 * })
 * ```
 *
 * Postgres:
 *
 * ```ts
 * uniqueIndex('files_sha256_live_key').on(t.sha256).where(sql`...`)
 * ```
 *
 * `partialFilterExpression` → `.where(...)` on a `uniqueIndex`, one for one.
 * The semantic that must survive is the REASON the filter exists: content-
 * addressed dedup must be unique among LIVE rows only, so a `deleted` tombstone
 * does not reserve its bytes forever and block a later upload of the same
 * content by another user or by a federation cache flow.
 *
 * The predicate is derived from `FILE_LIVE_STATUSES` rather than spelled twice,
 * so widening the live set cannot leave the index behind. It is written with a
 * literal `in (...)` list because an index predicate must be IMMUTABLE — the
 * same rule that governs generated columns.
 *
 * ## `ensureFileSha256LiveUniqueIndex()` does not travel
 *
 * That function is boot-time index reconciliation: it drops the legacy global
 * `sha256_1` index and creates the partial one on every start, and on a fresh
 * empty database it CRASHES the API (`MongoServerError: ns does not exist` →
 * `server.ts` `process.exit(1)`; the workaround is documented in `AGENTS.md`).
 * A migration is what index reconciliation is for. The DDL above IS the port of
 * that function; there is nothing left for it to do.
 *
 * ## `_id`, and the type that lied
 *
 * `IFile` declares `_id: string`, but `FileSchema` never declares `_id` and no
 * call site supplies one, so at runtime it has always been an ObjectId. The
 * primary key follows the DATA: `text`, holding the 24-hex verbatim, exactly
 * like every other table.
 *
 * ## `usageCount` is not here
 *
 * It is a Mongoose virtual over `links.length`. Derived values are computed:
 * `select count(*) from file_links where file_id = $1`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Lifecycle of a stored asset. `deleted` is a tombstone, not a removed row. */
export const FILE_STATUSES = ['active', 'trash', 'deleted'] as const;

/**
 * The statuses that hold a claim on their content hash.
 *
 * Mongo's `LIVE_FILE_STATUSES`, and the single source of the partial unique
 * index's predicate below.
 */
export const FILE_LIVE_STATUSES = ['active', 'trash'] as const;

/** Who may read the asset. */
export const FILE_VISIBILITIES = ['private', 'public', 'unlisted'] as const;

export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/** Classification of what the asset is FOR. */
export const FILE_PURPOSES = ['user', 'federation-media-cache', 'link-preview'] as const;

/**
 * System namespaces that own an asset instead of a user.
 *
 * Mongo stored these three sentinel STRINGS in `ownerUserId`, a column that
 * otherwise holds user ids — so the column could never carry a foreign key and
 * `mediaPrivacyService.ts:96` had to special-case "synthetic user IDs" by
 * eyeballing the string. Splitting them out is what lets `owner_user_id` become
 * a real constraint for the 99.99% of rows that ARE owned by a user, which is
 * the whole point of the migration.
 *
 * The values are the exact strings in use today —
 * `FEDERATION_AVATAR_OWNER_ID` (`services/assetService.ts:60`),
 * `FEDERATION_CACHE_OWNER_ID` (`constants/federationCache.ts:23`) and
 * `LINK_PREVIEW_OWNER_ID` (`services/linkPreview/constants.ts:140`) — so the
 * backfill is a straight move, not a mapping:
 *
 * ```sql
 * system_owner  = case when owner_user_id like '\_\_%' then owner_user_id end,
 * owner_user_id = case when owner_user_id like '\_\_%' then null else owner_user_id end
 * ```
 *
 * (An ObjectId hex can never start with `_`, so the discriminator is exact.)
 * The call-site port replaces those three scattered constants with this one
 * closed set.
 */
export const FILE_SYSTEM_OWNERS = [
  '__federation__',
  '__federation_media_cache__',
  '__link_preview_cache__',
] as const;

export const files = pgTable(
  'files',
  {
    id: generatedId(),
    /** SHA-256 hex of the content. Unique among live rows — see above. */
    sha256: text().notNull(),
    /** Bytes. `bigint`: an asset is media, and media outgrows `int4`. */
    size: bigint({ mode: 'number' }).notNull(),
    mime: text().notNull(),
    ext: text().notNull(),
    /**
     * The owning account, or NULL for a system-owned asset — in which case
     * `system_owner` names the namespace. Exactly one of the two is set, and
     * the CHECK below says so.
     *
     * `CASCADE`: deleting an account deletes its assets. Note the interaction
     * with `message_attachments.file_id` (`ON DELETE no action`): if another
     * user's stored mail still carries one of these files as an attachment, the
     * account deletion is REFUSED rather than silently emptying that message.
     */
    ownerUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** The system namespace that owns this asset, when no user does. */
    systemOwner: text({ enum: FILE_SYSTEM_OWNERS }),
    status: text({ enum: FILE_STATUSES }).notNull().default('active'),
    visibility: text({ enum: FILE_VISIBILITIES }).notNull().default('private'),
    purpose: text({ enum: FILE_PURPOSES }).notNull().default('user'),
    /** Object key in S3. */
    storageKey: text().notNull(),
    /**
     * The filename the uploading client supplied, echoed back to every viewer
     * and mirrored onto `message_attachments.name`.
     *
     * CALL-SITE OBLIGATION. Mongoose ran `normalizeFileName` — i.e.
     * `normalizeInlineText` — as a schema SETTER, the API's one sanctioned
     * setter, because four independent upload paths write this leaf field and
     * there is no chokepoint to put the call in. Postgres has no setter, and it
     * cannot have a generated column here either: `normalizeInlineText` begins
     * with `String.prototype.normalize('NFC')` (`packages/core/src/utils/
     * textNormalization.ts:118`), and Postgres has no IMMUTABLE Unicode
     * normalization function in core — so the derivation the schema WOULD own
     * (per `CONVENTIONS.md`, "Generated columns") is not expressible.
     *
     * So each of the four paths must call `normalizeInlineText` before writing:
     *
     *   1. `routes/assets.ts:382`  — direct upload (`originalName` in the body)
     *   2. `routes/assets.ts:681`  — streamed upload (`x-original-name` header)
     *   3. `routes/assets.ts:766`  — chunked-complete
     *   4. `routes/assets.ts:864`  — media-cache
     *
     * Deliberately not a CHECK: a CHECK would reject any production row written
     * before the setter existed and convert a silent normalization into a 500
     * during backfill.
     */
    originalName: text(),
    /** Intrinsic media metadata (dimensions, duration, …) — genuinely shape-less. */
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ---- the partial unique -----------------------------------------------
    uniqueIndex('files_sha256_live_key')
      .on(t.sha256)
      .where(
        sql`${t.status} in (${sql.raw(
          FILE_LIVE_STATUSES.map((value) => `'${value}'`).join(', ')
        )})`
      ),

    // ---- the compounds Mongo declared -------------------------------------
    index('files_owner_user_id_status_idx').on(t.ownerUserId, t.status),
    index('files_owner_user_id_visibility_status_idx').on(t.ownerUserId, t.visibility, t.status),
    index('files_visibility_status_idx').on(t.visibility, t.status),
    // `assetService.ts:88` — dedup lookup across every status, including the
    // tombstones the partial unique deliberately does not cover.
    index('files_sha256_status_idx').on(t.sha256, t.status),
    index('files_purpose_owner_user_id_status_idx').on(t.purpose, t.ownerUserId, t.status),
    index('files_created_at_idx').on(t.createdAt.desc()),
    // Mongo additionally declared standalone `{sha256}`, `{ownerUserId}`,
    // `{status}`, `{visibility}`, `{purpose}` and `{mime}`. Five are covered by
    // a compound that leads with them. `{status}` and `{mime}` are not, and are
    // dropped rather than ported: no query filters on either alone (every
    // status read is scoped by owner, visibility or sha256; nothing filters by
    // mime at all), and an index nobody uses still costs every write.
    // The system-owned namespaces are reached through `purpose` above, so
    // `system_owner` gets no index of its own.

    check(
      'files_status_check',
      sql`${t.status} in (${sql.raw(FILE_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'files_visibility_check',
      sql`${t.visibility} in (${sql.raw(
        FILE_VISIBILITIES.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    check(
      'files_purpose_check',
      sql`${t.purpose} in (${sql.raw(FILE_PURPOSES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'files_system_owner_check',
      sql`${t.systemOwner} is null or ${t.systemOwner} in (${sql.raw(
        FILE_SYSTEM_OWNERS.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    // Every asset has exactly one owner: an account, or a system namespace.
    check(
      'files_owner_exclusive_check',
      sql`(${t.ownerUserId} is null) <> (${t.systemOwner} is null)`
    ),
    check('files_size_check', sql`${t.size} >= 0`),
  ]
);
