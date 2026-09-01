/**
 * Oxy-scoped signed-record types.
 *
 * The base `signedRecordEnvelopeSchema` (`./identity`) treats `type` as an OPEN,
 * non-empty string so ANY Oxy app may sign on the shared envelope grammar. The
 * Oxy STORE re-narrows it to the closed set in this module — a `type` outside it
 * is rejected as `invalid_envelope`.
 *
 * `oxySignedRecordTypeSchema` is that runtime gate (the API's `verifyEnvelope`
 * re-narrows with it; the Mongoose `SignedRecord.type` enum and the Postgres
 * CHECK on `signed_records.type` are both derived from `.options`);
 * `OxySignedRecordType` is the matching compile-time union the SDK
 * identity/civic mixins type against.
 *
 * The signing input INCLUDES `type`, so this set is part of the signed bytes —
 * a record cannot have its category swapped after signing, and a value once
 * signed can never be renamed.
 *
 * v1 only ever carried `identity` / `profile` (already in production); v2 added
 * the civic record types (reputation attestations, real-life / peer validations,
 * personhood vouches, verifiable credentials) and the user-node registration
 * record.
 *
 * ## Why `app_record` is here, when it deliberately was not
 *
 * This set used to hold Oxy's own categories only, and said so: an app's `type`
 * was "intentionally NOT in this set". The reason given was that the store
 * accepts only what it knows how to **verify and materialize**. Verification
 * turned out not to argue for the exclusion — the engine verifies a signature
 * against the subject's keys whatever the category says — and materialization
 * is the app's job, not the store's: an app projects its own feed tables from
 * records it reads back.
 *
 * What changed is the decision the exclusion blocked. One chain per PERSON, held
 * by Oxy, is the ecosystem substrate: apps append their records to the subject's
 * one chain instead of each keeping a private chain for the same person. A
 * closed set that admits no app category makes that unrepresentable.
 *
 * `app_record` is ONE value rather than an open lane, and the lexicon lives in
 * the envelope's `collection` (`app.mention.feed.post`, `app.syra.*`), which the
 * store denormalizes to `signed_records.nsid` and indexes. So a new app needs no
 * change here — it picks its own collection namespace and signs `app_record`,
 * exactly as Mention already does in production. Keeping the set closed is what
 * keeps the CHECK a real constraint.
 *
 * **Admitting the category is not the whole of that decision.** Two gates sit
 * beside it and are unchanged: an app record must arrive as a v2 (chained)
 * envelope, and `oxyVerificationResolver` accepts exactly one custodial issuer
 * (`OXY_DID`). So a record a user signs themselves verifies here today, while
 * one an app signs custodially under its OWN issuer DID does not — that needs a
 * separate, deliberate answer about which issuers may write to a person's chain.
 *
 * Platform-agnostic — zod only, no react/react-native/expo, ESM-safe.
 */

import { z } from 'zod';

export const oxySignedRecordTypeSchema = z.enum([
    'identity',
    'profile',
    'reputation_attestation',
    'real_life_attestation',
    'validation_verdict',
    'personhood_vouch',
    'credential',
    'node',
    // Any Oxy app's own record. The LEXICON is the envelope's `collection`, not
    // this value — see the header.
    'app_record',
]);

/**
 * The closed set of record categories the Oxy identity/civic/node store accepts.
 * The base envelope `type` is an open string; this is what the Oxy store
 * re-narrows it to.
 */
export type OxySignedRecordType = z.infer<typeof oxySignedRecordTypeSchema>;
