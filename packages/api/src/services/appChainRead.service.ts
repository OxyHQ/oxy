/**
 * The multi-subject READ an app projects a cross-app feed from.
 *
 * `oxyRecordStore.listRecordsByAuthors` is the query; this is the layer that
 * decides what a caller may ask for. The split matters: the store takes its
 * collection filter from whoever calls it and has no notion of a public
 * collection, so if a request's filter reached it unchanged, a caller could name
 * `app.mention.feed.bookmark` and receive everyone's saved posts.
 *
 * The narrowing happens HERE and is not optional — `publicCollectionsAmong`
 * intersects the request against `config/chainCollectionPolicy.ts`, where an
 * undeclared collection is private. A request naming only private collections
 * gets an empty page rather than an error, matching how an empty filter already
 * behaves, because "you may not read that" and "there is nothing there" are the
 * same answer to someone who should not know the difference.
 *
 * ## The cursor is opaque on purpose
 *
 * It encodes `(createdAt, id)`, the keyset the store pages by. Callers get a
 * string and hand it back; they do not construct one. That keeps the pagination
 * axis an implementation detail — and it stops a caller pinning `createdAt` to
 * an arbitrary point to probe when a specific record was written.
 */

import {
  MAX_RECORD_AUTHORS,
  MAX_RECORD_COLLECTIONS,
  oxyRecordStore,
  type AuthorRecordCursor,
} from './oxyRecordStore';
import { publicCollectionsAmong } from '../config/chainCollectionPolicy';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/** The scope a service credential must carry to read across subjects. */
export const CHAINS_READ_SCOPE = 'chains:read';

export { MAX_RECORD_AUTHORS, MAX_RECORD_COLLECTIONS };

/** One record as a reader sees it: the envelope plus who wrote it and under what. */
export interface PublicChainRecord {
  recordId: string;
  oxyUserId: string;
  collection: string;
  envelope: SignedRecordEnvelope;
}

export interface PublicChainPage {
  records: PublicChainRecord[];
  /** Opaque; hand it back as `since` to continue. `null` at the end of the stream. */
  nextCursor: string | null;
}

/** Encode a keyset position as an opaque string. */
export function encodeChainCursor(cursor: AuthorRecordCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor a caller handed back, or `null` when it is not one we issued.
 *
 * A malformed cursor is `null` rather than a throw: the caller then reads from
 * the start, which is the same thing that happens when they pass nothing. An
 * error would leak that the format is guessable.
 */
export function decodeChainCursor(raw: string): AuthorRecordCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    if (separator <= 0) return null;
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    // Not base64, not ours. Same answer as a cursor we never issued.
    return null;
  }
}

/**
 * Records published by any of `oxyUserIds` under any PUBLIC collection among
 * `collections`, oldest first, from `since`.
 *
 * The caller re-polls from slightly BEFORE its last cursor and dedupes by
 * `recordId`: `created_at` is a transaction-start time, so a row can commit
 * behind a cursor that already passed it. Re-delivering a record costs bytes;
 * skipping one costs a post that never appears. `listRecordsByAuthors` carries
 * the full reasoning.
 */
export async function readPublicChainRecords(args: {
  oxyUserIds: readonly string[];
  collections: readonly string[];
  since?: string | null;
  limit?: number;
}): Promise<PublicChainPage> {
  const collections = publicCollectionsAmong(args.collections);
  if (collections.length === 0) {
    return { records: [], nextCursor: null };
  }

  const page = await oxyRecordStore.listRecordsByAuthors({
    userIds: args.oxyUserIds,
    collections,
    after: args.since ? decodeChainCursor(args.since) : null,
    limit: args.limit,
  });

  return {
    records: page.records.map((row) => ({
      recordId: row.recordId,
      oxyUserId: row.userId,
      collection: row.nsid,
      envelope: row.envelope,
    })),
    nextCursor: page.nextCursor ? encodeChainCursor(page.nextCursor) : null,
  };
}
