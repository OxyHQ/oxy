/**
 * `file_sources` — where an imported file came from (ADR 0042 D7).
 *
 * `POST /assets/service/app/import` (and the account-owned
 * `/service/user-media/import`) fetches a source URL with Oxy's own SSRF-safe
 * fetcher and stores the bytes through the ordinary upload pipeline. This row
 * remembers, per OWNER and per URL, which file that produced and the validators
 * the source answered with, so the next import of the same URL by the same
 * owner returns the file without downloading anything — and, when asked to
 * revalidate, sends a conditional GET (`If-None-Match` / `If-Modified-Since`).
 *
 * ## One owner, like `files`
 *
 * Exactly one of `owner_user_id` / `owner_application_id` is set (CHECK). A
 * platform namespace never imports. Two partial uniques make (owner, URL) one
 * row, the same way `files` makes (owner, sha256) one live row.
 *
 * ## The URL is provenance, kept hashed — and sealed, not in clear
 *
 * A supplier URL is routinely a capability (a signed CDN link, a token in the
 * query). The row is keyed by `source_url_sha256` (SHA-256 of the normalized
 * URL) and carries `source_host` in clear for operators; the URL itself is
 * `source_url_ciphertext`, sealed by `utils/secretBox.ts` with the row's owner
 * and hash as associated data, so a database dump alone never reveals it and a
 * ciphertext copied onto another owner's row does not open. Only the owner is
 * ever answered with it.
 *
 * ## What the import does NOT decide
 *
 * A changed source makes a NEW file (deduplicated by content hash per owner)
 * and repoints this row; the previous file loses nothing automatically — its
 * references decide its life (ADR 0042 D5).
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { files } from './files';
import { users } from './users';

export const fileSources = pgTable(
  'file_sources',
  {
    id: generatedId(),
    /** `CASCADE`: provenance of an account's import goes with the account. */
    ownerUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `CASCADE`: an application row only ever goes with its owning account's
     * hard delete, after its files went first (`files.owner_application_id` is
     * `RESTRICT`); the provenance has nobody left to answer.
     */
    ownerApplicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the normalized source URL (`new URL(...).toString()`). */
    sourceUrlSha256: text().notNull(),
    /** The URL's host, in clear: what an operator may see about a source. */
    sourceHost: text().notNull(),
    /** The URL itself, sealed (`secretBox`, context `file-source|<owner>|<hash>`). */
    sourceUrlCiphertext: text().notNull(),
    /**
     * The file the last successful fetch stored. `CASCADE`: a file row is only
     * removed by an account's deletion (otherwise it is tombstoned), and then
     * its provenance goes with it. A tombstoned file is not reused: the next
     * import downloads again.
     */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** The source's `ETag` on that fetch, verbatim, for `If-None-Match`. */
    etag: text(),
    /** The source's `Last-Modified` on that fetch, verbatim, for `If-Modified-Since`. */
    lastModified: text(),
    /** SHA-256 of the bytes that fetch stored (equals the file's `sha256`). */
    contentSha256: text().notNull(),
    /** When the source was last asked (a full GET, or a conditional one). */
    fetchedAt: timestamptz().notNull(),
    /** The HTTP status of that last ask: 200 for a download, 304 for "unchanged". */
    lastStatus: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'file_sources_owner_exclusive_check',
      sql`num_nonnulls(${t.ownerUserId}, ${t.ownerApplicationId}) = 1`,
    ),
    uniqueIndex('file_sources_owner_user_id_source_url_sha256_key')
      .on(t.ownerUserId, t.sourceUrlSha256)
      .where(sql`${t.ownerUserId} is not null`),
    uniqueIndex('file_sources_owner_application_id_source_url_sha256_key')
      .on(t.ownerApplicationId, t.sourceUrlSha256)
      .where(sql`${t.ownerApplicationId} is not null`),
    // The cascade from `files` and "which sources produced this file".
    index('file_sources_file_id_idx').on(t.fileId),
  ],
);

export type FileSourceRow = typeof fileSources.$inferSelect;
