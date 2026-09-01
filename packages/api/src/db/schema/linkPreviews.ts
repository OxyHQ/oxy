/**
 * `link_previews` — resolved (or in-flight) link previews behind
 * `/links/preview` + `/links/previews`.
 *
 * Ported from `models/LinkPreview.ts`.
 *
 * The primary key is the SHA-256 hex of the NORMALIZED requested URL, supplied
 * by the caller — so a lookup by URL is a primary-key read and one URL can never
 * produce two rows. This is the one table in this batch whose `id` has no
 * generated default; see `CONVENTIONS.md`.
 *
 * PRIVACY INVARIANT: `image_url` / `favicon` are always Oxy-hosted URLs.
 * `origin_image_url` / `origin_favicon_url` hold the raw remote URLs and are
 * SERVER-ONLY — serializing them would leak the viewer's IP to the origin.
 * Drizzle's `db.select().from(linkPreviews)` returns EVERY column, so unlike
 * Mongoose there is no schema-level guard: reads that feed a client DTO must
 * select columns explicitly.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { LinkPreviewStatus } from '@oxyhq/contracts';
import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * Resolution states, mirroring `@oxyhq/contracts`' `LinkPreviewStatus`.
 *
 * `satisfies` proves every value here is a valid status; `LinkPreviewStatusGap`
 * proves the reverse, so adding a status in contracts fails THIS file's
 * typecheck rather than silently allowing a value the CHECK constraint rejects
 * at runtime.
 */
export const LINK_PREVIEW_STATUSES = [
  'resolved',
  'pending',
  'empty',
] as const satisfies readonly LinkPreviewStatus[];

/** `never` while `LINK_PREVIEW_STATUSES` covers the contract union. */
export type LinkPreviewStatusGap = Exclude<
  LinkPreviewStatus,
  (typeof LINK_PREVIEW_STATUSES)[number]
>;

export const linkPreviews = pgTable(
  'link_previews',
  {
    /** SHA-256 hex of the normalized requested URL. Always supplied by the caller. */
    id: text().primaryKey(),
    /** The normalized URL that was requested/resolved. */
    requestedUrl: text().notNull(),
    /** Canonical / final URL after following redirects. */
    canonicalUrl: text().notNull(),
    title: text(),
    description: text(),
    siteName: text(),
    /** Oxy-hosted favicon URL returned to clients. */
    favicon: text(),
    /** Oxy-hosted image URL returned to clients. */
    imageUrl: text(),
    /** SERVER-ONLY raw remote image URL, used to re-host on refresh. */
    originImageUrl: text(),
    /** SERVER-ONLY raw remote favicon URL. */
    originFaviconUrl: text(),
    status: text({ enum: LINK_PREVIEW_STATUSES }).notNull().default('pending'),
    /** Resolver version that produced this row. */
    version: integer().notNull().default(0),
    /** When the preview was last (re)resolved. */
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('link_previews_status_idx').on(t.status),
    // Refresh sweeps query by recency of resolution.
    index('link_previews_updated_at_idx').on(t.updatedAt.desc()),
    check(
      'link_previews_status_check',
      sql`${t.status} in ('resolved', 'pending', 'empty')`
    ),
  ]
);
