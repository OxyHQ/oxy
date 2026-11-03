/**
 * Holder-context evidence: the server's point-in-time observation of which
 * shared-device context a bearer is installed in, bound to ONE installation of
 * that bearer in this client (ADR 0053).
 *
 * Evidence is never authorization. It lets a caller that already captured a
 * viewer intent prove, before a write is dispatched, that the bearer the write
 * will carry belongs to that viewer's account and actor, and then pin the write
 * to the exact installation with `expectedCredentialGeneration`. Anything that
 * cannot be proven is `unavailable`, and the caller keeps its existing checks.
 */
import type { HolderContextEvidenceV1Response } from '@oxy.so/contracts';
import type { CredentialGeneration } from '../HttpService';

/** The identifiers the server observed; none of them is a credential. */
export type HolderEvidenceIdentity = Readonly<
  Pick<
    HolderContextEvidenceV1Response,
    'deviceId' | 'deviceSessionId' | 'contextId' | 'actorId' | 'accountId' | 'sessionId'
  >
>;

export interface HolderEvidence {
  /** The installation of the bearer this evidence was observed for. */
  readonly generation: CredentialGeneration;
  readonly identity: HolderEvidenceIdentity;
  /** The device-session revision the server observed. */
  readonly deviceRevision: number;
  /** Epoch milliseconds: the earlier of the bearer and session expiry. */
  readonly expiresAtMs: number;
}

/**
 * Why no evidence exists. Every reason means "keep the existing checks": none of
 * them says the session is revoked, and none may clear or refresh credentials.
 *
 * - `no_credential`: no bearer is installed, or it comes from a pull-only provider.
 * - `no_holder`: this client holds no device credential to prove the holder with.
 * - `changed`: the bearer was replaced while the evidence was being acquired.
 * - `unsupported`: a delegated, OAuth or legacy bearer, or the endpoint is not offered.
 * - `binding_unavailable`: the server could not match holder, context and bearer.
 * - `unavailable`: the endpoint is off, rate limited, unreachable or answered wrongly.
 */
export type HolderEvidenceUnavailableReason =
  | 'no_credential'
  | 'no_holder'
  | 'changed'
  | 'unsupported'
  | 'binding_unavailable'
  | 'unavailable';

export type HolderEvidenceResult =
  | { readonly status: 'ok'; readonly evidence: HolderEvidence }
  | { readonly status: 'unavailable'; readonly reason: HolderEvidenceUnavailableReason };

/** The one comparison that decides whether two observations name the same viewer context. */
export function sameHolderIdentity(a: HolderEvidenceIdentity, b: HolderEvidenceIdentity): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.deviceSessionId === b.deviceSessionId &&
    a.contextId === b.contextId &&
    a.actorId === b.actorId &&
    a.accountId === b.accountId &&
    a.sessionId === b.sessionId
  );
}
