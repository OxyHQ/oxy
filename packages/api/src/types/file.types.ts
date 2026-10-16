/**
 * The stored-asset aggregate, as the application sees it.
 *
 * `files` and its two child tables (`file_references`, `file_variants`) are ONE
 * aggregate: nothing reads a reference or a variant without the file it belongs
 * to, and `files.status` is decided by whether any reference remains. So the row types
 * are declared together here, and every read that returns a file returns the
 * whole aggregate.
 *
 * The value sets are derived from the schema's own tuples rather than re-spelt,
 * so a CHECK constraint and the TypeScript union can never disagree.
 *
 * **`usageCount` is not a field.** It is `file.links.length` at the point of
 * use. A stored
 * counter would be a second source of truth for a number the rows already
 * answer — see `schema/files.ts`.
 */

import type {
  FILE_LIVE_STATUSES,
  FILE_PURPOSES,
  FILE_STATUSES,
  FILE_SYSTEM_OWNERS,
  FILE_VISIBILITIES,
  fileAccessGrants,
  fileReferences,
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
 * They live in their own column, never as sentinel strings in the user-id
 * column, and `owner_user_id is null` is the exact, total discriminator.
 */
export type FileSystemOwner = (typeof FILE_SYSTEM_OWNERS)[number];

/**
 * Who owns an asset: an account, a system namespace, or an application (ADR
 * 0043) — exactly one, never two, never none.
 *
 * `files_owner_exclusive_check` says exactly this in SQL. Saying it in the type
 * too means a write path cannot even construct the ambiguous case, so the CHECK
 * is a backstop for raw SQL rather than the only thing standing between a
 * sentinel string and the user-id column.
 *
 * `ownerApplicationId` is optional on the first two arms so the account and
 * namespace owners every existing path spells keep their shape; absent and
 * `null` mean the same column value.
 */
export type FileOwner =
  | { ownerUserId: string; systemOwner: null; ownerApplicationId?: null }
  | { ownerUserId: null; systemOwner: FileSystemOwner; ownerApplicationId?: null }
  | { ownerUserId: null; systemOwner: null; ownerApplicationId: string };

/** The three owner columns of a stored row, as every reader sees them. */
export type FileOwnerColumns = {
  ownerUserId: string | null;
  systemOwner: string | null;
  ownerApplicationId: string | null;
};

/** One place an application uses an asset (`file_references`, ADR 0043 D4). */
export type FileReferenceRecord = typeof fileReferences.$inferSelect;

/**
 * A person's consent (or its revocation) for one application to read one of
 * their files with its service token (`file_access_grants`, ADR 0043 stage 4c).
 */
export type FileAccessGrantRecord = typeof fileAccessGrants.$inferSelect;

/** One derived rendition of an asset (thumbnail, `720p`, HLS playlist, …). */
export type FileVariantRecord = typeof fileVariants.$inferSelect;

/**
 * A rendition as it is PRODUCED, before its row exists. Insert-shaped, so the
 * columns a renderer may legitimately not fill (`width`/`height` on an HLS
 * playlist, `size` before upload, `ready_at` while still encoding) are optional
 * rather than an explicit `null` at every construction site.
 */
export type NewFileVariant = Omit<typeof fileVariants.$inferInsert, 'fileId'>;

/**
 * A stored asset together with every reference and variant it owns.
 *
 * `links` keeps its name from `file_links`: it holds the file's
 * `file_references` rows, and `links.length` is still its usage count.
 */
export type FileRecord = typeof files.$inferSelect & {
  links: FileReferenceRecord[];
  variants: FileVariantRecord[];
  /**
   * The owner's consent decisions per application (ADR 0043 stage 4c) — read
   * with the file so a cached record answers "may this application read it"
   * (`fileReference.service.mayApplicationRead`); every write to the table
   * invalidates the file's cache entry.
   */
  accessGrants: FileAccessGrantRecord[];
};
