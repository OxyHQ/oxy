import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { userLinkMetadata } from '../db/schema/userLinkMetadata';
import { ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import type { LinkMetadataDto } from '../utils/publicUserProjection';
import {
  assertLinkUrl,
  readLinkDocuments,
  resolveLinkDocuments,
  type ClarityLinkDocument,
} from './clarityLinkDocuments.service';

/**
 * A profile's links. Oxy keeps, per link, the Clarity document id, the owner's
 * own title and the position; the URL and everything about the page come from
 * Clarity. See `clarityLinkDocuments.service.ts`.
 */

/** How long a save waits for Clarity to fetch a link it has not seen before. */
const SAVE_WAIT_MS = 8000;

/** How long a source verification waits for Clarity; it can be retried later. */
const SOURCE_WAIT_MS = 2000;

/** The title an owner may give a link. Longer titles are cut, not refused. */
const TITLE_MAX = 40;

/** One link as the client sends it. */
export interface ProfileLinkInput {
  url: string;
  title?: string;
}

/** What a stored link row holds. A row from before the backfill has no document id yet. */
export interface ProfileLinkRow {
  position: number;
  clarityDocumentId: string | null;
  title: string | null;
  /** Legacy columns, populated only on rows the backfill has not reached yet. */
  url?: string | null;
  description?: string | null;
  image?: string | null;
}

/** A stored row, ready to insert. */
export interface ProfileLinkRowInsert {
  userId: string;
  position: number;
  clarityDocumentId: string;
  title: string | null;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = Array.from(value.trim()).slice(0, TITLE_MAX).join('');
  return trimmed.length > 0 ? trimmed : null;
}

/** Reads the client's `linksMetadata` array, dropping entries without a URL. */
export function parseProfileLinkInputs(value: readonly unknown[]): ProfileLinkInput[] {
  const out: ProfileLinkInput[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { url, title } = entry as { url?: unknown; title?: unknown };
    if (typeof url !== 'string' || url.trim().length === 0) continue;
    out.push({ url: url.trim(), title: cleanTitle(title) ?? undefined });
  }
  return out;
}

/**
 * The rows for these links, each resolved to its Clarity document. Two URLs
 * that name one document keep the first. `pending` lists the URLs Clarity has
 * not fetched yet, which have no row.
 */
async function resolveLinkRows(
  userId: string,
  inputs: readonly ProfileLinkInput[],
  waitMs: number,
): Promise<{ rows: ProfileLinkRowInsert[]; pending: string[] }> {
  for (const input of inputs) assertLinkUrl(input.url);
  const { documents, pending } = await resolveLinkDocuments(
    [...new Set(inputs.map((input) => input.url))],
    waitMs,
  );
  const seen = new Set<string>();
  const rows: ProfileLinkRowInsert[] = [];
  for (const input of inputs) {
    const document = documents.get(input.url);
    if (!document || seen.has(document.id)) continue;
    seen.add(document.id);
    rows.push({
      userId,
      position: rows.length,
      clarityDocumentId: document.id,
      title: input.title ?? null,
    });
  }
  return { rows, pending: pending.map((entry) => entry.url) };
}

/**
 * The rows a save writes for these links. A link Clarity has not fetched yet
 * fails the save with the URLs still pending, so the client can retry rather
 * than store an address Oxy cannot show.
 */
export async function buildProfileLinkRows(
  userId: string,
  inputs: readonly ProfileLinkInput[],
): Promise<ProfileLinkRowInsert[]> {
  const { rows, pending } = await resolveLinkRows(userId, inputs, SAVE_WAIT_MS);
  if (pending.length > 0) {
    throw new ConflictError('Some links are still being prepared; try again shortly', {
      field: 'linksMetadata',
      pendingUrls: pending,
    });
  }
  return rows;
}

/** A source profile's links, as its account shows them. */
export interface SourceProfileLink {
  title: string;
  url: string;
}

/**
 * Brings a federated account's links in line with the source profile it was
 * verified from. The account is a Clarity-backed profile like a native one, so
 * its links are the same rows.
 *
 * If any link is still being fetched by Clarity, the account keeps the links it
 * already had and the next verification writes the full set: a half-written
 * list would drop a link the source still publishes. Returns whether the rows
 * were replaced.
 */
export async function replaceSourceProfileLinks(
  userId: string,
  links: readonly SourceProfileLink[],
): Promise<'replaced' | 'kept'> {
  const { rows, pending } = await resolveLinkRows(
    userId,
    links.map((link) => ({ url: link.url, title: link.title })),
    SOURCE_WAIT_MS,
  );
  if (pending.length > 0) return 'kept';
  await getDb().transaction(async (tx) => {
    await tx.delete(userLinkMetadata).where(eq(userLinkMetadata.userId, userId));
    if (rows.length > 0) await tx.insert(userLinkMetadata).values(rows);
  });
  return 'replaced';
}

/**
 * The link list a reader sees, in position order. A row names its document in
 * Clarity; a document Clarity no longer has is left out. A row from before the
 * backfill still carries its legacy URL and is shown from it. If Clarity cannot
 * be reached, the document-backed links are left out for this read and the rest
 * stay, so one outage does not blank a profile.
 */
export async function hydrateProfileLinks(
  rows: readonly ProfileLinkRow[],
): Promise<LinkMetadataDto[]> {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const ids = ordered.flatMap((row) => (row.clarityDocumentId ? [row.clarityDocumentId] : []));
  let documents = new Map<string, ClarityLinkDocument | null>();
  if (ids.length > 0) {
    try {
      documents = await readLinkDocuments(ids);
    } catch (error) {
      logger.warn('Profile links could not be read from Clarity; showing the rest', {
        error: error instanceof Error ? error.message : String(error),
      });
      documents = new Map();
    }
  }

  const out: LinkMetadataDto[] = [];
  for (const row of ordered) {
    if (!row.clarityDocumentId) {
      if (row.url) {
        out.push({
          url: row.url,
          title: row.title ?? row.url,
          description: row.description ?? '',
          ...(row.image ? { image: row.image } : {}),
        });
      }
      continue;
    }
    const document = documents.get(row.clarityDocumentId);
    if (!document) continue;
    out.push({
      url: document.canonicalUrl,
      title: row.title ?? document.title ?? document.canonicalUrl,
      description: document.description ?? '',
      // An absent image or favicon is omitted, not sent as `null`: `null` would be a new value on the wire.
      ...(document.imageUrl ? { image: document.imageUrl } : {}),
      ...(document.faviconUrl ? { faviconUrl: document.faviconUrl } : {}),
    });
  }
  return out;
}
