/**
 * What a URL in a content claim names (ADR 0041 D10).
 *
 * A claimant pastes whatever address they have. Some name an Oxy FILE, and
 * those resolve here to the `files` row and its bytes:
 *
 *  - the CDN by id: `https://cloud.oxy.so/<fileId>` (CloudFront's `/cdn/:id`);
 *  - the CDN by key: `https://cloud.oxy.so/content/<y>/<m>/<pp>/<sha>.<ext>`
 *    and `…/variants/<y>/<m>/<pp>/<sha>/<type>.<ext>` — a stored object,
 *    matched to the row whose original or rendition is that key, or else by
 *    the SHA-256 the key carries;
 *  - the API: `/cdn/<fileId>`, `/assets/<fileId>`, `/assets/<fileId>/stream`,
 *    `/download` and `/url` on an Oxy API host.
 *
 * Everything else — a post on Mention, a listing on Mercaria, any page — stays
 * an UNRESOLVED target: a person opens it and attaches the files it shows by
 * id in the console. Nothing here fetches a URL: a claim is untrusted input,
 * and resolving a page by fetching it would make the intake an SSRF probe.
 *
 * A file of any status resolves, a tombstone included: what matters is the
 * bytes, which the claim then holds as evidence while it is open.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import { applyPublicPrefix, getAssetCdnUrl, stripPublicPrefix } from '../../config/cdn';
import { getDb } from '../../config/postgres';
import { files, fileVariants } from '../../db/schema';

/** The resolution of one URL. */
export type ResolvedContentUrl =
  | { resolution: 'file'; fileId: string; sha256: string }
  | { resolution: 'unresolved' };

/** The hosts the Oxy API answers on, besides the one the claim was posted to. */
export const OXY_API_HOSTS: readonly string[] = ['api.oxy.so'];

/** A file id: a legacy 24-hex ObjectId or a uuid v7. Anything else is not one. */
const FILE_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The SHA-256 a content-addressed key carries. */
const KEY_SHA256 = /(?:^|\/)([0-9a-f]{64})(?:[./-]|$)/;

/** What a URL looks like it names, before the database is asked. */
export type ContentUrlShape =
  | { kind: 'fileId'; fileId: string }
  | { kind: 'storageKey'; key: string; sha256: string | null }
  | { kind: 'other' };

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Classify a URL by its host and path alone. */
export function contentUrlShape(
  rawUrl: string,
  options: { apiHosts: readonly string[]; cdnHost?: string | null } = { apiHosts: OXY_API_HOSTS },
): ContentUrlShape {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'other' };
  }
  const host = url.host.toLowerCase();
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const cdnHost = options.cdnHost === undefined ? hostOf(getAssetCdnUrl()) : options.cdnHost;

  if (cdnHost && host === cdnHost) {
    if (segments.length === 1 && FILE_ID.test(segments[0])) {
      return { kind: 'fileId', fileId: segments[0] };
    }
    if (segments[0] === 'content' || segments[0] === 'variants') {
      const key = segments.join('/');
      return { kind: 'storageKey', key, sha256: KEY_SHA256.exec(key)?.[1] ?? null };
    }
    return { kind: 'other' };
  }

  if (options.apiHosts.map((value) => value.toLowerCase()).includes(host)) {
    // `/api` is the prefix some clients and docs carry in front of the routes.
    const path = segments[0] === 'api' ? segments.slice(1) : segments;
    if (path[0] === 'cdn' && path.length === 2 && FILE_ID.test(path[1])) {
      return { kind: 'fileId', fileId: path[1] };
    }
    if (
      path[0] === 'assets' &&
      FILE_ID.test(path[1] ?? '') &&
      (path.length === 2 || (path.length === 3 && ['stream', 'download', 'url'].includes(path[2])))
    ) {
      return { kind: 'fileId', fileId: path[1] };
    }
  }
  return { kind: 'other' };
}

/** Resolve a URL to the file it names, asking the database. */
export async function resolveContentUrl(
  rawUrl: string,
  options: { apiHosts: readonly string[]; cdnHost?: string | null },
): Promise<ResolvedContentUrl> {
  const shape = contentUrlShape(rawUrl, options);
  const db = getDb();

  if (shape.kind === 'fileId') {
    const [row] = await db
      .select({ id: files.id, sha256: files.sha256 })
      .from(files)
      .where(eq(files.id, shape.fileId))
      .limit(1);
    return row
      ? { resolution: 'file', fileId: row.id, sha256: row.sha256 }
      : { resolution: 'unresolved' };
  }

  if (shape.kind === 'storageKey') {
    // The URL path is the key with `public/` stripped (CloudFront's origin
    // path), so the stored key is either spelling.
    const spellings = [applyPublicPrefix(shape.key), stripPublicPrefix(shape.key)];
    const [original] = await db
      .select({ id: files.id, sha256: files.sha256 })
      .from(files)
      .where(inArray(files.storageKey, spellings))
      .orderBy(asc(files.createdAt), asc(files.id))
      .limit(1);
    if (original) return { resolution: 'file', fileId: original.id, sha256: original.sha256 };
    const [rendition] = await db
      .select({ id: files.id, sha256: files.sha256 })
      .from(fileVariants)
      .innerJoin(files, eq(files.id, fileVariants.fileId))
      .where(inArray(fileVariants.key, spellings))
      .orderBy(asc(files.createdAt), asc(files.id))
      .limit(1);
    if (rendition) return { resolution: 'file', fileId: rendition.id, sha256: rendition.sha256 };
    if (shape.sha256) {
      // A key no row names any more (a rendition never recorded, an HLS
      // segment): the bytes are what the key says they are.
      const [byHash] = await db
        .select({ id: files.id, sha256: files.sha256 })
        .from(files)
        .where(eq(files.sha256, shape.sha256))
        .orderBy(asc(files.createdAt), asc(files.id))
        .limit(1);
      if (byHash) return { resolution: 'file', fileId: byHash.id, sha256: byHash.sha256 };
    }
  }

  return { resolution: 'unresolved' };
}
