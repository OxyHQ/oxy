import { type LinkPreview, linkPreviewSchema } from '@oxyhq/contracts';
import type { linkPreviews } from '../../db/schema';

/**
 * Fields the serializer reads off a stored preview. Deliberately a NARROW pick
 * that EXCLUDES `origin_image_url` / `origin_favicon_url` — the privacy
 * invariant is enforced at the type level here: the server-only origin URLs are
 * not even in scope for the mapping, so they can never be copied into the client
 * DTO.
 *
 * This matters MORE under drizzle than it did under Mongoose. Those two columns
 * were `select: false`, so a plain `find()` never loaded them; drizzle's
 * `db.select().from(linkPreviews)` returns every column, so the type is now the
 * only thing standing between a whole-row read and a leak of the origin URL
 * (which would tell the origin server the viewer's IP). The reads in
 * `linkPreviewService` therefore also enumerate their columns.
 */
export type SerializableLinkPreview = Pick<
  typeof linkPreviews.$inferSelect,
  | 'requestedUrl'
  | 'canonicalUrl'
  | 'title'
  | 'description'
  | 'siteName'
  | 'favicon'
  | 'imageUrl'
  | 'status'
  | 'resolvedAt'
>;

/**
 * Map a stored preview to the `@oxyhq/contracts` `LinkPreview` DTO.
 *
 * Hard rules:
 *  - `image` / `favicon` come ONLY from the Oxy-hosted `imageUrl` / `favicon`
 *    columns — NEVER from the raw `originImageUrl` / `originFaviconUrl` (which
 *    are not even in {@link SerializableLinkPreview}).
 *  - The output is run through `linkPreviewSchema.parse`, which strips any field
 *    not declared on the contract — a second, defense-in-depth guarantee that no
 *    server-only field can leak.
 *  - `resolvedAt` is emitted only for a `resolved` preview.
 */
export function serializeLinkPreview(doc: SerializableLinkPreview): LinkPreview {
  const dto: LinkPreview = {
    url: doc.canonicalUrl || doc.requestedUrl,
    status: doc.status,
  };

  if (doc.title) dto.title = doc.title;
  if (doc.description) dto.description = doc.description;
  if (doc.siteName) dto.siteName = doc.siteName;
  if (doc.imageUrl) dto.image = doc.imageUrl;
  if (doc.favicon) dto.favicon = doc.favicon;
  if (doc.status === 'resolved' && doc.resolvedAt) {
    dto.resolvedAt = doc.resolvedAt.toISOString();
  }

  return linkPreviewSchema.parse(dto);
}
