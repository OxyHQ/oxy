import { z } from 'zod';
import { isAccountIdFormat } from '../utils/validation';

/**
 * Schemas for the app-authored chain write (`POST /chains/records`).
 *
 * SECURITY: this endpoint lets a service credential append to an arbitrary
 * user's signed, append-only chain, with Oxy providing the signature. The schema
 * here enforces the structural contract only; the trust boundary — the
 * `chains:write` scope and the application's own `chainNamespaces` — is enforced
 * in `services/appChainWrite.service.ts`, which the route calls.
 *
 * Nothing here may be permissive in a way the service then has to re-check. In
 * particular `collection` is bounded and shaped, because it is the value the
 * namespace grant is matched against.
 */

/** An NSID is dotted segments — the shape `app.mention.feed.post` has. */
const NSID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;

/**
 * A record key. Opaque to Oxy — apps use their own local id — but bounded, and
 * refusing whitespace so `rkey` cannot carry a second value by smuggling.
 */
const RKEY_PATTERN = /^[A-Za-z0-9._~:-]+$/;

/**
 * Largest record payload accepted, in bytes of JSON.
 *
 * A chain is append-only, replicated to every node that follows the subject, and
 * committed to by the transparency log — so an oversized record is a cost
 * nothing can reclaim later. 64 KiB is far above a post or a listen event and
 * far below anything that would make the chain a blob store; blobs belong behind
 * a content address (`MtnBlobRef`), not inline.
 */
export const MAX_CHAIN_RECORD_BYTES = 64 * 1024;

export const appendChainRecordSchema = z.object({
  /** The chain's subject — the person the record is about. */
  oxyUserId: z.string().trim().refine(isAccountIdFormat, 'oxyUserId must be a valid account id'),
  collection: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .regex(NSID_PATTERN, 'collection must be a dotted NSID, e.g. app.mention.feed.post'),
  rkey: z.string().trim().min(1).max(512).regex(RKEY_PATTERN, 'rkey must be url-safe'),
  /**
   * The lexicon payload, passed through untouched. Oxy does not know any app's
   * lexicon and deliberately does not validate its shape — that is the app's
   * own contract, and a record's meaning lives in its `collection`.
   */
  record: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_CHAIN_RECORD_BYTES,
      `record must serialize to at most ${MAX_CHAIN_RECORD_BYTES} bytes`,
    ),
});

export type AppendChainRecordBody = z.infer<typeof appendChainRecordSchema>;

/** Comma-separated list in a query string → a trimmed, non-empty array. */
const commaList = z
  .string()
  .trim()
  .min(1)
  .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0));

/**
 * `GET /chains/records` — the multi-subject read.
 *
 * The caps are the store's own (`MAX_RECORD_AUTHORS` / `MAX_RECORD_COLLECTIONS`)
 * restated as a 400 rather than left to throw: an oversized request is the
 * caller's mistake and should say so, and the store refuses to truncate
 * precisely because a silently shortened author list reads as "these people
 * published nothing".
 */
export const readChainRecordsQuerySchema = z.object({
  authors: commaList.pipe(z.array(z.string().min(1)).min(1).max(300)),
  collections: commaList.pipe(z.array(z.string().min(1)).min(1).max(32)),
  /** Opaque cursor from a previous page. Never constructed by the caller. */
  since: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export type ReadChainRecordsQuery = z.infer<typeof readChainRecordsQuerySchema>;
