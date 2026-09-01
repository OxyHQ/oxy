/**
 * The stored-asset aggregate, as the application sees it.
 *
 * `files` and its two child tables (`file_links`, `file_variants`) are ONE
 * aggregate: nothing reads a link or a variant without the file it belongs to,
 * and `files.status` is decided by whether any link remains. So the row types
 * are declared together here, and every read that returns a file returns the
 * whole aggregate.
 *
 * The value sets are derived from the schema's own tuples rather than re-spelt,
 * so a CHECK constraint and the TypeScript union can never disagree.
 *
 * **`usageCount` is not a field.** Mongoose exposed it as a virtual over
 * `links.length`; here it is `file.links.length` at the point of use. A stored
 * counter would be a second source of truth for a number the rows already
 * answer — see `schema/files.ts`.
 */

import type {
  FILE_LIVE_STATUSES,
  FILE_PURPOSES,
  FILE_STATUSES,
  FILE_SYSTEM_OWNERS,
  FILE_VISIBILITIES,
  fileLinks,
  fileVariants,
  files,
} from '../db/schema';

/** Lifecycle of a stored asset. `deleted` is a tombstone, not a removed row. */
export type FileStatus = (typeof FILE_STATUSES)[number];

/** The statuses that hold a claim on their content hash. */
export type FileLiveStatus = (typeof FILE_LIVE_STATUSES)[number];

/**
 * Who may read the asset.
 * - `private`: only the owner (default)
 * - `public`: anyone, unauthenticated (avatars, public profile content)
 * - `unlisted`: reachable by direct link but never listed
 */
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/**
 * What the asset is FOR. `user` is an ordinary upload; the other two name a
 * system namespace whose owner is a {@link FileSystemOwner} rather than an
 * account.
 */
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * The system namespaces that own an asset instead of a user.
 *
 * Mongo stored these as sentinel STRINGS in the same column that otherwise held
 * user ids, which is why `mediaPrivacyService` had to recognise them by their
 * shape. Here they live in their own column and `owner_user_id is null` is the
 * exact, total discriminator.
 */
export type FileSystemOwner = (typeof FILE_SYSTEM_OWNERS)[number];

/**
 * Who owns an asset: an account, or a system namespace — never both, never
 * neither.
 *
 * `files_owner_exclusive_check` says exactly this in SQL. Saying it in the type
 * too means a write path cannot even construct the ambiguous case, so the CHECK
 * is a backstop for raw SQL rather than the only thing standing between a
 * sentinel string and the user-id column, which is what it was in Mongo.
 */
export type FileOwner =
  | { ownerUserId: string; systemOwner: null }
  | { ownerUserId: null; systemOwner: FileSystemOwner };

/** One place an asset is used. */
export type FileLinkRecord = typeof fileLinks.$inferSelect;

/** One derived rendition of an asset (thumbnail, `720p`, HLS playlist, …). */
export type FileVariantRecord = typeof fileVariants.$inferSelect;

/**
 * A rendition as it is PRODUCED, before its row exists. Insert-shaped, so the
 * columns a renderer may legitimately not fill (`width`/`height` on an HLS
 * playlist, `size` before upload, `ready_at` while still encoding) are optional
 * rather than an explicit `null` at every construction site.
 */
export type NewFileVariant = Omit<typeof fileVariants.$inferInsert, 'fileId'>;

/** A stored asset together with every link and variant it owns. */
export type FileRecord = typeof files.$inferSelect & {
  links: FileLinkRecord[];
  variants: FileVariantRecord[];
};
