/**
 * Verification-method resolution — the injected authorization policy the chain
 * engine consults to decide whether an envelope's signing key is allowed to
 * write to the subject's chain.
 *
 * The engine is identity-agnostic: it does NOT know about Oxy DIDs, the `User`
 * model, custodial keys, or any app's notion of "current key". It asks an
 * injected {@link VerificationMethodResolver} to resolve a subject DID to its
 * current verification methods (plus the optional custodial issuer that may sign
 * provenance records ABOUT the subject), then applies the uniform authorization
 * rule in {@link isAuthorizedKey}.
 *
 * This is what lets the SAME engine serve Oxy identity/civic records (where the
 * resolver reads `User.publicKey`/`authMethods` and the Oxy custodial key), a
 * self-hosted node (where the authority is a configured owner key), and Mention
 * posts (subject VMs from the Oxy DID + a Mention custodial server key) — each
 * supplies its own resolver; the decision logic lives here, once.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import type { RejectionReason } from '../chain/types';

/**
 * The verification methods that may sign records on a subject's chain.
 *
 *  - `currentPublicKeys` — the subject's OWN current signing keys (self-issued
 *    records: `issuer === subject`). Empty when the subject has no self-sovereign
 *    key (e.g. a custodial-only account).
 *  - `custodialIssuer` / `custodialPublicKey` — an optional custodial authority
 *    that may sign provenance records ABOUT the subject (`issuer ===
 *    custodialIssuer`), and the single public key it signs with. Both present or
 *    both absent. The custodial public key is published (it lives in a DID
 *    document), so a plain-equality comparison is sufficient — it is not a
 *    secret.
 */
export interface ResolvedVerificationMethods {
  currentPublicKeys: string[];
  custodialIssuer?: string;
  custodialPublicKey?: string;
}

export interface VerificationMethodResolver {
  /**
   * Resolve a subject DID to its current verification methods, or `null` when the
   * subject is unknown / cannot be resolved (no key is then authorized).
   */
  resolve(subjectDid: string): Promise<ResolvedVerificationMethods | null>;
}

/** Verdict of the key-authorization decision (a subset of {@link RejectionReason}). */
export type KeyAuthorization =
  | { ok: true }
  | { ok: false; reason: Extract<RejectionReason, 'public_key_not_a_current_verification_method' | 'untrusted_issuer'> };

/**
 * Decide whether `env`'s signing key (`env.publicKey`) is authorized for its
 * `issuer`, given the subject's resolved verification methods:
 *
 *  - **Self-issued** (`issuer === subject`): the key MUST be one of the subject's
 *    `currentPublicKeys`; otherwise `public_key_not_a_current_verification_method`.
 *  - **Custodial** (`issuer === custodialIssuer`): the key MUST equal
 *    `custodialPublicKey`; otherwise `public_key_not_a_current_verification_method`.
 *  - **Any other issuer** (including an unresolvable subject): `untrusted_issuer`.
 *
 * The signature itself is checked separately (against `env.publicKey`), so this
 * only decides whether that key is an authorized writer — it is not a trust
 * shortcut.
 */
export function isAuthorizedKey(
  resolved: ResolvedVerificationMethods | null,
  env: SignedRecordEnvelope,
): KeyAuthorization {
  if (resolved !== null && env.issuer === env.subject) {
    return resolved.currentPublicKeys.includes(env.publicKey)
      ? { ok: true }
      : { ok: false, reason: 'public_key_not_a_current_verification_method' };
  }

  if (
    resolved !== null &&
    resolved.custodialIssuer !== undefined &&
    env.issuer === resolved.custodialIssuer
  ) {
    return resolved.custodialPublicKey !== undefined && env.publicKey === resolved.custodialPublicKey
      ? { ok: true }
      : { ok: false, reason: 'public_key_not_a_current_verification_method' };
  }

  return { ok: false, reason: 'untrusted_issuer' };
}
