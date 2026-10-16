/**
 * `files` — one stored asset in the Oxy file manager.
 *
 * Ported from `models/File.ts`.
 *
 * ## One live row per OWNER per content hash
 *
 * A row is an owner's claim on some bytes; the bytes themselves are
 * content-addressed storage (`content/…/<sha256>.<ext>`, `variants/…/<sha256>/…`)
 * that any number of rows may point at. Two partial uniques say so:
 *
 * ```ts
 * uniqueIndex('files_sha256_owner_user_live_key').on(t.sha256, t.ownerUserId).where(live and owner_user_id is not null)
 * uniqueIndex('files_sha256_system_owner_live_key').on(t.sha256, t.systemOwner).where(live and system_owner is not null)
 * uniqueIndex('files_owner_application_id_sha256_live_key').on(t.ownerApplicationId, t.sha256).where(live and owner_application_id is not null)
 * ```
 *
 * One index per owner column rather than one over
 * `coalesce(owner_user_id, system_owner, owner_application_id)`:
 * `files_owner_exclusive_check` already makes exactly one of the three columns
 * non-null, so each index covers its part of the table with a plain column
 * list — no expression for a query to match, and the owner lookup
 * (`sha256 = $1 and owner_user_id = $2`) is served by the index directly.
 *
 * It USED to be one live row per hash across the whole table
 * (`files_sha256_live_key`). That made
 * content dedup hand an EXISTING row — and its id, its links and its delete
 * authority — to whichever other account uploaded the same bytes, so owners
 * ended up holding one another's files and one owner's delete removed another's
 * media. Migration `0124_files_per_owner_live_key` replaced it.
 *
 * Storage is shared, rows are not: a second owner's upload of the same bytes
 * gets its OWN row pointing at the same object, and the bytes go only when the
 * last live row using them does (`accountStorageDeletion.worker.ts`, under the
 * content-hash lock of `services/contentHashLock.ts`).
 *
 * The filter is partial for a REASON: a `deleted` tombstone is not a claim, so
 * it never blocks a later upload.
 *
 * The predicate is derived from `FILE_LIVE_STATUSES` rather than spelled twice,
 * so widening the live set cannot leave the index behind. It is written with a
 * literal `in (...)` list because an index predicate must be IMMUTABLE — the
 * same rule that governs generated columns.
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
 * It is derived from the reference count, and derived values are computed:
 * `select count(*) from file_references where file_id = $1`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/**
 * Lifecycle of a stored asset. `deleted` is a tombstone, not a removed row.
 *
 * Only `active` is ever served (ADR 0041 D5): `trash`, `blocked` and `deleted`
 * are refused by every read path and leave the CDN (`config/cdn.isServableStatus`).
 *
 * `blocked` is a takedown (ADR 0041 D10, `services/contentClaims/`): the bytes
 * are on `blocked_content_hashes` after a content claim, and EVERY live row
 * holding them is blocked — whoever owns it. Only staff move a row into or out
 * of it (a reinstatement returns it to `active`, or to `trash` when it was
 * there, which `trashed_at` remembers). It is still a claim on its bytes
 * (`FILE_LIVE_STATUSES`): the bytes are kept, as evidence and for a
 * reinstatement, and the per-owner unique keeps a second row of them from
 * being created underneath it.
 */
export const FILE_STATUSES = ['active', 'trash', 'blocked', 'deleted'] as const;

/**
 * The statuses that hold a claim on their content hash.
 *
 * The single source of the partial unique index's predicate below, of the
 * storage purge's "does a live row still use these bytes" guard and of what a
 * metered owner's quota counts.
 */
export const FILE_LIVE_STATUSES = ['active', 'trash', 'blocked'] as const;

/** `status in ('active', 'trash', 'blocked')` as SQL text, for hand-written statements. */
export const FILE_LIVE_STATUS_SQL_LIST = FILE_LIVE_STATUSES.map((value) => `'${value}'`).join(', ');

/** Who may read the asset. */
export const FILE_VISIBILITIES = ['private', 'public', 'unlisted'] as const;

export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/** Classification of what the asset is FOR. */
export const FILE_PURPOSES = ['user', 'federation-media-cache', 'sticker'] as const;

/**
 * System namespaces that own an asset instead of a user.
 *
 * Stored as sentinel STRINGS in `owner_user_id`, a column that otherwise holds
 * user ids, the column could never carry a foreign key and every reader would
 * have to special-case "synthetic user IDs" by eyeballing the string. Splitting
 * them out is what lets `owner_user_id` become
 * a real constraint for the 99.99% of rows that ARE owned by a user, which is
 * the whole point of the migration.
 *
 * The values are the exact strings in use today —
 * `FEDERATION_AVATAR_OWNER_ID` (`services/assetService.ts:60`),
 * `FEDERATION_CACHE_OWNER_ID` (`constants/federationCache.ts:23`) — so the
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
  // The sticker catalogue's animations and fallbacks (`schema/stickers.ts`).
  '__stickers__',
] as const;

/** `status in ('active', 'trash')`, as an IMMUTABLE literal list for an index predicate. */
function liveStatusPredicate(status: AnyPgColumn) {
  return sql`${status} in (${sql.raw(FILE_LIVE_STATUS_SQL_LIST)})`;
}

export const files = pgTable(
  'files',
  {
    id: generatedId(),
    /** SHA-256 hex of the content. Unique among one owner's live rows — see above. */
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
    /**
     * The APPLICATION that owns this asset, when neither an account nor a
     * system namespace does (ADR 0041): content such as Mercaria's category
     * tiles, which belongs to no person. A `third_party` application's bytes
     * are metered against `applications.owner_account_id`, its billing
     * principal (ADR 0007); Oxy's own applications are not metered (D2).
     *
     * `RESTRICT`, never `CASCADE`. A cascade would drop the rows and with them
     * the only record of which storage keys the bytes live at, so nothing would
     * ever purge them. Whoever removes an application removes its files FIRST,
     * through the tombstone + `storage_object_deletions` path: an
     * application's deletion tombstones them all (ADR 0041 D8,
     * `applicationDeletion.service.ts`), and `recordAccountStorageDeletion`
     * removes the rows before the account cascade, the only hard delete of an
     * application.
     */
    ownerApplicationId: text().references(() => applications.id, { onDelete: 'restrict' }),
    status: text({ enum: FILE_STATUSES }).notNull().default('active'),
    visibility: text({ enum: FILE_VISIBILITIES }).notNull().default('private'),
    purpose: text({ enum: FILE_PURPOSES }).notNull().default('user'),
    /** Object key in S3. */
    storageKey: text().notNull(),
    /**
     * The filename the uploading client supplied, echoed back to every viewer
     * and mirrored onto `message_attachments.name`.
     *
     * CALL-SITE OBLIGATION. The value must pass through `normalizeFileName` —
     * i.e. `normalizeInlineText` — and four independent upload paths write this
     * leaf field with no chokepoint to put the call in. Postgres has no setter,
     * and it
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
    /**
     * Since when NO `file_references` row names this file, or NULL while one
     * does (ADR 0041 D5). Maintained in the transaction that changes the
     * reference set (`fileRepository.ts`): set when the last reference goes
     * and at insert (a new file is used by nothing yet), cleared by any new
     * reference. Under a row lock on the file, so two concurrent removals of
     * its last two references cannot both read the other's as still there.
     *
     * What it means depends on the owner. An ACCOUNT's file is only marked
     * *not in use* for its person (never trashed or deleted for it); an
     * APPLICATION's file is collected by `fileLifecycle.worker.ts` 24 hours
     * after this instant. The worker re-checks the reference set itself, so a
     * stale value can delay a collection but never cause a wrong one.
     */
    unreferencedSince: timestamptz(),
    /**
     * When the file entered `trash`, or NULL outside it. An application's file
     * is purged 30 days after this (ADR 0041 D5); an account's trash never
     * expires, and this is only shown.
     */
    trashedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ---- the per-owner partial uniques (see the header) --------------------
    uniqueIndex('files_sha256_owner_user_live_key')
      .on(t.sha256, t.ownerUserId)
      .where(sql`${liveStatusPredicate(t.status)} and ${t.ownerUserId} is not null`),
    uniqueIndex('files_sha256_system_owner_live_key')
      .on(t.sha256, t.systemOwner)
      .where(sql`${liveStatusPredicate(t.status)} and ${t.systemOwner} is not null`),
    // Owner first: the same index also answers "this application's live row
    // for these bytes" and leads every application-scoped lookup.
    uniqueIndex('files_owner_application_id_sha256_live_key')
      .on(t.ownerApplicationId, t.sha256)
      .where(sql`${liveStatusPredicate(t.status)} and ${t.ownerApplicationId} is not null`),

    // ---- compound indexes --------------------------------------------------
    index('files_owner_user_id_status_idx').on(t.ownerUserId, t.status),
    index('files_owner_user_id_visibility_status_idx').on(t.ownerUserId, t.visibility, t.status),
    index('files_visibility_status_idx').on(t.visibility, t.status),
    // Every row holding a hash, whoever owns it: the storage-sharing lookups
    // (a new owner's row reuses an existing object), the purge's "does any live
    // row still use these bytes" guard, and the tombstones the partial uniques
    // deliberately do not cover.
    index('files_sha256_status_idx').on(t.sha256, t.status),
    index('files_purpose_owner_user_id_status_idx').on(t.purpose, t.ownerUserId, t.status),
    index('files_created_at_idx').on(t.createdAt.desc()),
    // An application's files, newest first (`GET /assets/service/app`'s
    // cursor), and the referencing-row probe the `RESTRICT` foreign key runs
    // when an application row is deleted — `owner_application_id = $1`
    // implies the partial predicate, so tombstones are covered too. Partial,
    // so the user-owned 99.99% of the table costs it nothing.
    index('files_owner_application_id_created_at_idx')
      .on(t.ownerApplicationId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.ownerApplicationId} is not null`),
    // The lifecycle sweep (`fileLifecycle.worker.ts`, ADR 0041 D5). Each is
    // partial to exactly the rows one step reads, so the account-owned 99% of
    // the table costs them nothing:
    //  - an application's active file nobody uses, oldest first (→ trash);
    //  - an application's trashed file, oldest first (→ purge after 30 days);
    //  - an upload `POST /assets/init` created and `/complete` never finished
    //    (no name, no metadata) — swept after 24 hours when it holds no object.
    index('files_application_unreferenced_since_idx')
      .on(t.unreferencedSince)
      .where(
        sql`${t.ownerApplicationId} is not null and ${t.status} = 'active' and ${t.unreferencedSince} is not null`,
      ),
    index('files_application_trashed_at_idx')
      .on(t.trashedAt)
      .where(sql`${t.ownerApplicationId} is not null and ${t.status} = 'trash'`),
    //  - an application's BLOCKED file nobody uses, once no open claim holds
    //    its bytes (→ tombstone + purge, `purgeBlocked`, ADR 0041 D10).
    index('files_application_blocked_unreferenced_since_idx')
      .on(t.unreferencedSince)
      .where(sql`${t.ownerApplicationId} is not null and ${t.status} = 'blocked'`),
    index('files_pending_upload_created_at_idx')
      .on(t.createdAt)
      .where(
        sql`${t.status} = 'active' and ${t.ownerUserId} is not null and ${t.originalName} is null and ${t.metadata} is null`,
      ),
    // No single-column indexes: `sha256`, `owner_user_id`, `visibility` and
    // `purpose` are each covered by a compound that leads with them. `status`
    // and `mime` are not, and get none: no query filters on either alone (every
    // status read is scoped by owner, visibility or sha256; nothing filters by
    // mime at all), and an index nobody uses still costs every write.
    // The system-owned namespaces are reached through `purpose` above, so
    // `system_owner` gets no index of its own.

    check(
      'files_status_check',
      sql`${t.status} in (${sql.raw(FILE_STATUSES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'files_visibility_check',
      sql`${t.visibility} in (${sql.raw(
        FILE_VISIBILITIES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    check(
      'files_purpose_check',
      sql`${t.purpose} in (${sql.raw(FILE_PURPOSES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'files_system_owner_check',
      sql`${t.systemOwner} is null or ${t.systemOwner} in (${sql.raw(
        FILE_SYSTEM_OWNERS.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    // Every asset has exactly one owner: an account, a system namespace, or an
    // application. `num_nonnulls` counts NULLs as false, so the CHECK holds
    // exactly when one column is set — never zero, never two.
    check(
      'files_owner_exclusive_check',
      sql`num_nonnulls(${t.ownerUserId}, ${t.systemOwner}, ${t.ownerApplicationId}) = 1`,
    ),
    check('files_size_check', sql`${t.size} >= 0`),
  ],
);
