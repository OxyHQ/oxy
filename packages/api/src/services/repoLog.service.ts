/**
 * Repo Log Service — the thin Oxy read-side glue over {@link oxyRecordStore}
 * (self-sovereign identity layer — F0.2 hash chain).
 *
 * Read helpers over a subject's per-subject signed-record hash chain. These
 * power the public chain endpoints and the node-sync log (Fase 5): a node pulls
 * the ordered log since a cursor, checks the head, and materializes the current
 * value of each AtProto-style (collection, rkey) key.
 *
 * All reads are served from Oxy's fast copy (`SignedRecord` + `RepoHead`, via the
 * store) — never from a user node (the absolute read-path invariant). The public
 * functions are keyed by Oxy `userId`; the protocol store is keyed by the subject
 * DID, so the glue maps `userId → buildUserDid(userId)`.
 *
 * The only Oxy POLICY here is {@link PUBLIC_LOG_COLLECTIONS} — the allowlist of
 * NSIDs an unauthenticated node bootstrap may export. It is config that lives in
 * oxy-api (the protocol store has no notion of "public collections").
 */

import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import type { ChainHead } from '@oxyhq/protocol';
import { oxyRecordStore, subjectKeyForUser, DEFAULT_LOG_LIMIT } from './oxyRecordStore';
import { NODE_COLLECTION } from '../utils/nodes.constants';

/**
 * Public-safe NSIDs that unauthenticated node bootstrap may export.
 *
 * DELIBERATELY not derived from `chainCollectionPolicy`'s
 * `PUBLIC_CHAIN_COLLECTIONS`, and the distinction is load-bearing: that policy
 * answers "may this collection be published at all", while this answers "does a
 * bootstrapping node need it". Deriving one from the other would start exporting
 * every app's public records — Mention posts included — from a CORS-open route
 * whose purpose is letting a node verify an identity.
 *
 * The relationship that DOES hold is containment: nothing here may be a
 * collection the policy calls private. `__tests__/chainCollectionPolicy.test.ts`
 * asserts it, so the two cannot drift into disagreeing.
 */
export const PUBLIC_LOG_COLLECTIONS = ['app.oxy.identity', 'app.oxy.profile', NODE_COLLECTION] as const;

/**
 * The ordered slice of a subject's chain with `seq > sinceSeq`, ascending by
 * `seq`, capped at `limit`. Only v2 (chained) records have a `seq`, so v1 rows
 * are naturally excluded. Pass `sinceSeq = -1` to start from genesis.
 */
export async function getLogSince(
  userId: string,
  sinceSeq: number,
  limit: number = DEFAULT_LOG_LIMIT,
): Promise<SignedRecordEnvelope[]> {
  return oxyRecordStore.getLogSince(subjectKeyForUser(userId), sinceSeq, limit);
}

/**
 * Public node-bootstrap log export — only verified records whose collection is
 * in {@link PUBLIC_LOG_COLLECTIONS}. Civic attestations, credentials, reputation
 * provenance, and any private collections stay out of the CORS-open log.
 */
export async function getPublicLogSince(
  userId: string,
  sinceSeq: number,
  limit: number = DEFAULT_LOG_LIMIT,
): Promise<SignedRecordEnvelope[]> {
  return oxyRecordStore.getPublicLogSince(userId, sinceSeq, limit, PUBLIC_LOG_COLLECTIONS);
}

/**
 * Resolve a `recordId` cursor to its chain `seq` for the public node log. A node
 * resumes a pull by passing the last `recordId` it ingested. Returns `null` when
 * no such (v2) record exists for the user.
 */
export async function resolveCursorSeq(userId: string, recordId: string): Promise<number | null> {
  return oxyRecordStore.resolveCursorSeq(subjectKeyForUser(userId), recordId);
}

/** The subject's chain head, or `null` when the user has no chain yet. */
export async function getHead(userId: string): Promise<ChainHead | null> {
  return oxyRecordStore.getHead(subjectKeyForUser(userId));
}

/**
 * The latest VERIFIED record for an AtProto-style (collection, rkey) key — the
 * materialized "current" value (last-writer-wins by chain order), or `null` when
 * no verified record exists for that key.
 */
export async function materializeCurrent(
  userId: string,
  collection: string,
  rkey: string,
): Promise<SignedRecordEnvelope | null> {
  return oxyRecordStore.materializeCurrent(subjectKeyForUser(userId), collection, rkey);
}
