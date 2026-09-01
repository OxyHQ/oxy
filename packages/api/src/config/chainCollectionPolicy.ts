/**
 * Which chain collections may be published, and why — the committed policy.
 *
 * A person has ONE chain, and an app appends its records to it. That chain
 * therefore interleaves collections meant to be read by anyone with collections
 * that are private by KIND rather than by any per-record visibility flag: a
 * Mention post is public because it was published public, while a Mention
 * bookmark is private no matter what, and both land in the same log under the
 * same subject.
 *
 * The store cannot tell them apart. `oxyRecordStore` filters on `nsid` and knows
 * nothing about what an `nsid` means — as `repoLog.service` already said of its
 * own allowlist, "the protocol store has no notion of public collections". So
 * the knowledge has to be written down, and this is where.
 *
 * ## Shape borrowed from `federationBridgePolicy` / `federationBlockPolicy`
 *
 * Committed rather than configured, with the reason in the entry, so git is the
 * audit trail and a change is reviewable by someone who was not there. And
 * ENFORCEMENT reads the same array a reader would: {@link isPublicChainCollection}
 * and {@link PUBLIC_CHAIN_COLLECTIONS} both derive from
 * {@link CHAIN_COLLECTION_POLICY}, so a collection cannot be served publicly
 * without being listed here as public.
 *
 * ## Unknown means PRIVATE
 *
 * The default is the whole point. An app that adds a collection and forgets this
 * file gets it treated as private — its records simply do not appear on a public
 * read. The opposite default would publish an undeclared collection the first
 * time anybody wrote one, which is exactly how a private kind leaks: silently,
 * with no error, at the moment a new feature ships.
 */

import { NODE_COLLECTION } from '../utils/nodes.constants';

/** Whether a collection's records may be served to a reader who is not the subject. */
export type ChainCollectionVisibility = 'public' | 'private';

/** One declared collection: what it is, and whether it may be published. */
export interface ChainCollectionEntry {
  /** The envelope's `collection` NSID, stored denormalized as `signed_records.nsid`. */
  nsid: string;
  visibility: ChainCollectionVisibility;
  /**
   * Why it carries that visibility, in terms of what the collection IS. Written
   * for whoever later has to decide whether a new collection resembles this one.
   */
  reason: string;
}

/**
 * Every collection Oxy knows about, with its publishability.
 *
 * Adding an app collection here is a moderation-shaped decision, not plumbing:
 * marking one `public` makes every record ever written under it readable by any
 * consumer of a public read surface, retroactively, because a chain is
 * append-only and nothing is re-examined.
 */
export const CHAIN_COLLECTION_POLICY: readonly ChainCollectionEntry[] = [
  // ---- Oxy's own collections (the node-bootstrap log) ----------------------
  {
    nsid: 'app.oxy.identity',
    visibility: 'public',
    reason:
      'The identity record is what a node or any third party verifies an account against; it is useless if it cannot be fetched.',
  },
  {
    nsid: 'app.oxy.profile',
    visibility: 'public',
    reason: 'The profile a user publishes about themselves — public by intent.',
  },
  {
    nsid: NODE_COLLECTION,
    visibility: 'public',
    reason:
      'The node registration is how a self-hosted node is discovered; it advertises an endpoint the user chose to advertise.',
  },

  // ---- Mention (`app.mention.feed.*`) --------------------------------------
  //
  // Visibility here is the APP's knowledge, transcribed. The source of truth for
  // what each collection is stays `@mention/shared-types`' lexicons module; this
  // records the publishability decision Oxy enforces.
  {
    nsid: 'app.mention.feed.post',
    visibility: 'public',
    reason:
      'Only published, PUBLIC posts are ever emitted as records — `MentionRecordEmitter.isPublicPublishedPost` gates the write, so a private post has no record to leak.',
  },
  {
    nsid: 'app.mention.feed.repost',
    visibility: 'public',
    reason: 'A repost is a public act of amplification, and names a post that is itself public.',
  },
  {
    nsid: 'app.mention.feed.like',
    visibility: 'public',
    reason:
      'Likes are attributable in the product — a post shows who liked it — so the record discloses nothing the app does not.',
  },
  {
    nsid: 'app.mention.feed.tombstone',
    visibility: 'public',
    reason:
      'A tombstone supersedes an earlier record; withholding it would leave readers showing content the author deleted.',
  },
  {
    nsid: 'app.mention.feed.bookmark',
    visibility: 'private',
    reason:
      'A saved post is private by KIND, not by any visibility flag — `@mention/shared-types` declares it "excluded from any public log". Publishing it would disclose what a person reads, which they never shared.',
  },
];

/** Index for the lookup, built once. */
const BY_NSID: ReadonlyMap<string, ChainCollectionEntry> = new Map(
  CHAIN_COLLECTION_POLICY.map((entry) => [entry.nsid, entry]),
);

/**
 * Whether records of `nsid` may be served to someone other than the subject.
 *
 * An UNDECLARED collection is private — see the module header. Callers must not
 * "helpfully" fall back to allowing it.
 */
export function isPublicChainCollection(nsid: string): boolean {
  return BY_NSID.get(nsid)?.visibility === 'public';
}

/**
 * Every publishable collection, derived from the policy rather than repeated
 * beside it. This derivation is what makes it impossible to serve a collection
 * publicly that the policy above calls private.
 */
export const PUBLIC_CHAIN_COLLECTIONS: readonly string[] = CHAIN_COLLECTION_POLICY.filter(
  (entry) => entry.visibility === 'public',
).map((entry) => entry.nsid);

/**
 * Narrow a caller-supplied collection filter to the ones that may be published.
 *
 * The shape every public read surface should use: a request names what it wants,
 * and this decides what it may have. Returns the intersection — an empty result
 * means the caller asked only for private collections, which every read here
 * answers as an empty page rather than an error, matching how an empty filter
 * already behaves.
 */
export function publicCollectionsAmong(requested: readonly string[]): string[] {
  return requested.filter((nsid) => isPublicChainCollection(nsid));
}
