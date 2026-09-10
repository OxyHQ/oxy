/**
 * Envelope verification — the ordered state machine that decides whether a
 * signed-record envelope may be appended to its subject's chain.
 *
 * This is the engine that used to live, Oxy-specific, in
 * `api/services/signedRecord.service.verifyEnvelope`. Every Oxy detail has been
 * lifted out into the two injected collaborators:
 *  - the {@link VerificationMethodResolver} owns "is this key authorized for this
 *    issuer?" (self vs. custodial vs. untrusted),
 *  - the {@link RecordStore} owns the monotonicity frontier + the chain head.
 *
 * The ordered checks (first failure wins):
 *  1. **shape** — the base `signedRecordEnvelopeSchema` (open `type`, opaque
 *     `record`). An app re-narrows `type` to its own set in its adapter.
 *  2. **signature** — `verifyEnvelopeSignature` recomputes the canonical signing
 *     input and checks the secp256k1 signature against the embedded `publicKey`.
 *  3. **issuer authorization** — `resolver.resolve(subject)` + {@link isAuthorizedKey}.
 *  4. **freshness** — `issuedAt` not beyond the tolerated clock skew.
 *  5. **monotonicity** — `issuedAt` strictly newer than the store's latest record
 *     for the same logical key (replay/rollback defence).
 *  6. **continuity** — `checkContinuity` against the store's chain head (v1 skips).
 *
 * The `subject_mismatch` binding ("is the caller allowed to write for THIS
 * subject?") is intentionally NOT here — it is an adapter-policy decision the
 * caller makes before invoking the engine, not a property of the envelope.
 */

import { signedRecordEnvelopeSchema, type SignedRecordEnvelope } from '@oxy.so/contracts';
import { verifyEnvelopeSignature } from '../envelope/sign';
import { isAuthorizedKey, type VerificationMethodResolver } from '../identity/resolver';
import { checkContinuity } from './continuity';
import type { RecordStore } from './recordStore';
import type { VerifyOutcome } from './types';

/** Tunable verification options. */
export interface VerifyOptions {
  /** Tolerated forward clock skew for `issuedAt`, in ms. Default: 5 minutes. */
  clockSkewMs?: number;
  /** Override "now" (ms epoch) for deterministic tests. Default: `Date.now()`. */
  now?: number;
}

/** Default tolerated forward clock skew for a record's `issuedAt` (5 minutes). */
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Run the full verification state machine for `env` against the injected
 * `store` (monotonicity + continuity) and `resolver` (issuer authorization).
 * Returns a verdict; it never throws on a bad envelope.
 */
export async function verifyEnvelope(
  store: RecordStore,
  resolver: VerificationMethodResolver,
  env: SignedRecordEnvelope,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  // 1. Base envelope shape (open `type`, `record` opaque). An app's adapter
  //    re-narrows `type` to its own accepted set before/around this call.
  if (!signedRecordEnvelopeSchema.safeParse(env).success) {
    return { ok: false, reason: 'invalid_envelope' };
  }

  // 2. Signature is internally consistent with the embedded `publicKey`. Cheap,
  //    pure crypto — rejected before any store/resolver I/O.
  if (!(await verifyEnvelopeSignature(env))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Enforce that v2 envelopes strictly contain required chain fields.
  if (env.version === 2 && (typeof env.seq !== 'number' || typeof env.collection !== 'string' || typeof env.rkey !== 'string')) {
    return { ok: false, reason: 'invalid_envelope' };
  }

  // 3. The signing key is an authorized writer for the issuer (self-issued ⇒ a
  //    current VM of the subject; custodial ⇒ the custodial key; else untrusted).
  const resolved = await resolver.resolve(env.subject);
  const authorization = isAuthorizedKey(resolved, env);
  if (!authorization.ok) {
    return authorization;
  }

  // 4. Freshness: not issued beyond the tolerated forward clock skew.
  const now = opts.now ?? Date.now();
  const clockSkewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (env.issuedAt > now + clockSkewMs) {
    return { ok: false, reason: 'issued_in_future' };
  }

  // 5. Monotonicity: strictly newer than the latest record for the same key.
  const latestIssuedAt = await store.latestIssuedAtForKey(env.subject, env);
  if (latestIssuedAt !== null && env.issuedAt <= latestIssuedAt) {
    return { ok: false, reason: 'stale_issued_at' };
  }

  // 6. Continuity: the record extends the chain head by exactly one. Only v2 is
  //    chained, so v1 never reads the head (it has no chain to extend).
  if (env.version !== 2) {
    return { ok: true };
  }
  const head = await store.getHead(env.subject);
  return checkContinuity(head, env);
}
