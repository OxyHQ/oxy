/**
 * Generic "Oxy Protocol" record surface — the app-agnostic conventions every app
 * follows to decentralize its own content on the shared signed-record substrate.
 *
 * The base `signedRecordEnvelopeSchema` (`./identity`) is the WIRE grammar: a
 * signed envelope whose `type` is an open string and whose `record` is an opaque
 * `Record<string, unknown>`. An app layers its own LEXICON on top of that
 * grammar — a typed projection of the `record` payload, addressed by an
 * AtProto-style `(collection, rkey)` key — WITHOUT forking the envelope schema.
 *
 * ## Recipe — defining an app lexicon record
 *
 * For each record kind an app wants to publish:
 *
 * 1. Define the `record` PAYLOAD schema as a `z.ZodType<XPayload>` (e.g.
 *    `app.mention.feed.post` → `mentionPostRecordSchema: z.ZodType<MentionPost>`).
 *    This validates ONLY the inner `record`, not the envelope.
 * 2. Declare the `collection` NSID as a constant (e.g.
 *    `export const MENTION_POST_COLLECTION = 'app.mention.feed.post'`).
 * 3. Reuse the UNCHANGED {@link signedRecordEnvelopeSchema} for the envelope. The
 *    base treats `record` as `z.record(z.unknown())`, so the app validates the
 *    envelope with the base schema first, then parses `envelope.record` with its
 *    own payload schema. {@link LexiconRecord} is the typed projection that pairs
 *    the `(collection, rkey)` key with the parsed payload.
 *
 * The Oxy civic contracts (`./civic`) already follow this convention implicitly:
 * each civic record (`real_life_attestation`, `personhood_vouch`, `credential`,
 * …) ships a `record`-payload schema and is carried by the base envelope.
 *
 * ## Chain-wire shapes
 *
 * {@link ChainHeadResponse} and {@link LogPageResponse} are the shared response
 * shapes every chain store exposes (Oxy's `GET /identity/records/:userId/chain/head`,
 * `GET /identity/head/:userId`, `GET /identity/log/:userId`, and any app node's
 * equivalents). They are defined ONCE here so producers and consumers (the API
 * handlers, the SDK identity/nodes mixins, app nodes) cannot drift.
 *
 * Platform-agnostic — zod only, no react/react-native/expo, ESM-safe.
 */

import { z } from 'zod';
import { signedRecordEnvelopeSchema, type SignedRecordEnvelope } from './identity';

/* -------------------------------------------------------------------------- */
/*  Lexicon record (typed projection of an envelope's `record`)               */
/* -------------------------------------------------------------------------- */

/**
 * The typed projection of a signed envelope's `record` payload, addressed by an
 * AtProto-style `(collection, rkey)` key.
 *
 * - `collection` is the lexicon NSID (e.g. `app.mention.feed.post`) — the
 *   envelope's `collection` field.
 * - `rkey` is the record key within the collection (e.g. a post id) — the
 *   envelope's `rkey` field.
 * - `record` is the app-typed payload (`TPayload`) the app validated out of the
 *   envelope's opaque `record`.
 *
 * This is a COMPILE-TIME convenience only: the wire shape is the base envelope.
 * An app builds a `LexiconRecord<TPayload>` from a verified envelope by parsing
 * `envelope.record` with its own `z.ZodType<TPayload>` payload schema.
 */
export interface LexiconRecord<TPayload> {
  collection: string;
  rkey: string;
  record: TPayload;
}

/* -------------------------------------------------------------------------- */
/*  Chain-wire shapes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The current head of a subject's per-subject hash chain.
 *
 * `headRecordId` is the content address of the latest record (or `null` when the
 * subject has no chain yet); `seq` is its sequence number (`-1` when there is no
 * chain — so the next record's coordinates are always `seq: head.seq + 1`,
 * genesis `0`, and `prev: head.headRecordId`, genesis `null`); `recordCount` is
 * the total number of records on the chain.
 */
export interface ChainHeadResponse {
  headRecordId: string | null;
  seq: number;
  recordCount: number;
}

export const chainHeadResponseSchema: z.ZodType<ChainHeadResponse> = z.object({
  headRecordId: z.string().nullable(),
  seq: z.number().int(),
  recordCount: z.number().int().nonnegative(),
});

/**
 * An ordered page of a subject's verified signed-record chain — the FULL
 * envelopes (so a node or any verifier re-checks them independently). `count` is
 * `records.length`, echoed for convenience.
 */
export interface LogPageResponse {
  records: SignedRecordEnvelope[];
  count: number;
}

export const logPageResponseSchema: z.ZodType<LogPageResponse> = z.object({
  records: z.array(signedRecordEnvelopeSchema),
  count: z.number().int().nonnegative(),
});
