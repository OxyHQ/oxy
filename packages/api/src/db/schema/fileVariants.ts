/**
 * `file_variants` — one derived rendition of an asset (thumbnail, `720p`, …).
 *
 * Ported from the `variants` array in `models/File.ts`.
 *
 * A child table rather than `jsonb`: `variantService` resolves ONE variant by
 * type (`variantService.ts:207`), rewrites a single entry in place
 * (`assetService.ts:445`) and copies the whole set between content-addressed
 * twins (`variantService.ts:292`). Rewriting one element of a `jsonb` array is
 * a read-modify-write of the whole document; here it is an `update … where`.
 *
 * `metadata` stays `jsonb` because it genuinely differs per renderer — codec
 * settings for a video variant, none at all for a thumbnail.
 *
 * ## No unique on `(file_id, type)`, deliberately
 *
 * A regeneration removes the stale entry and inserts the replacement
 * (`assetService.ts:445`), so a unique constraint would depend on those two
 * statements never being observed in the wrong order. `getUsableReadyVariant`
 * already selects on `type` AND `ready_at`, which is the real predicate: an
 * unfinished variant and a live one for the same type is a legitimate
 * intermediate state, not a violation.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { generatedId, timestamptz } from '@oxyhq/db';
import { files } from './files';

export const fileVariants = pgTable(
  'file_variants',
  {
    id: generatedId(),
    /** A rendition has no meaning without its source. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** Renderer-defined name: `thumbnail`, `webp`, `720p`, `1080p`, … */
    type: text().notNull(),
    /** Object key in S3. */
    key: text().notNull(),
    width: integer(),
    height: integer(),
    /**
     * When the rendition finished. NULL means "still being produced" — and
     * `getUsableReadyVariant` requires it, so this is the liveness flag.
     */
    readyAt: timestamptz(),
    size: bigint({ mode: 'number' }),
    /** Renderer settings — genuinely shape-less, differs per variant type. */
    metadata: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    // Serves both reads there are: every variant of a file, and one variant by
    // type. Mongo had neither — the array came along with its parent document.
    index('file_variants_file_id_type_idx').on(t.fileId, t.type),
    check('file_variants_size_check', sql`${t.size} is null or ${t.size} >= 0`),
  ]
);
