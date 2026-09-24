/**
 * Present-requester assertions for native product agents (ADR 0025).
 *
 * A first-party product backend (Homiio) holds a signed-in person's verified Oxy
 * session on the request it is serving. To let Alia run that person's chat turn
 * through the product's native agent (Sindi) WITHOUT a consent screen and
 * WITHOUT forwarding the human bearer to Alia, the product trades the session
 * for a one-use, two-minute assertion here, and Alia consumes it through
 * introspection.
 *
 * ## What each half proves
 *
 * MINT proves, live: the caller is one pinned entry point for the named agent —
 * by its credential, or by attesting the IAM role that entry point declares
 * (ADR 0026), which is one identity with two proofs and not two identities; the
 * row behind whichever proof it used is still live and trusted with
 * `inference:invoke`; the presented access token is a valid, bound, live session
 * whose owner account is active; and that session is the shared first-party
 * session or the calling application's own. The session id and requester are
 * stored server-side under the `jti`, never placed in the token.
 *
 * INTROSPECT proves, live and exactly once: the token is ours, for Alia, and is
 * being presented by the application and the exact service identity it was
 * minted for (`cid` names what called: a credential id, or a `wl_…` attestation
 * handle); the entry point and the product principal are still live; the server-side record
 * exists and is consumed atomically (a second presentation finds nothing); and
 * the session it names is still active, read past every cache, still owned by
 * the same account, which is still active.
 *
 * ## Fail closed
 *
 * Every refusal is one opaque answer to the caller. The reason goes to the log.
 * A replay store that cannot answer in production refuses, rather than
 * degrading to "reusable for two minutes".
 */

import { randomUUID, type KeyObject } from 'node:crypto';
import {
  OxyRequesterAssertionError,
  readOxyRequesterAssertionKeyId,
  signOxyRequesterAssertion,
  verifyOxyRequesterAssertion,
  type OxyRequesterAssertionClaims,
  type OxyRequesterAssertionErrorCode,
} from '@oxy.so/core/server';
import {
  REQUESTER_ASSERTION_AUDIENCE,
  nativeProductAgentEntryPoint,
  type NativeProductAgentEntryPointMatch,
  type NativeProductAgentPrincipal,
} from '../config/nativeProductAgents';
import type { AttestationProvider } from './workloadAttestation.service';

export const REQUESTER_ASSERTION_TTL_SECONDS = 120;
const REQUIRED_SERVICE_SCOPE = 'inference:invoke';

type RequesterAssertionClaims = OxyRequesterAssertionClaims;

/** What Oxy keeps under the `jti` for the assertion's lifetime. */
export interface RequesterAssertionRecord {
  readonly sessionId: string;
  readonly requesterAccountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly agentId: string;
}

export interface LiveServicePrincipal {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
}

/**
 * The attestation path's live principal: the BINDING ROW, plus the application
 * and owner it hangs off.
 *
 * There is no `ApplicationCredential` on this path, so there is nothing for
 * `resolvePrincipal` to find and the credential check cannot simply be skipped
 * — it is the live ceiling. `application_workload_identities` is its exact
 * counterpart (ADR 0026): staff write the row, it names one role and one
 * application, it can expire, and since #1350 it names scopes. Deleting it,
 * expiring it, dropping a scope from it, deactivating the application or
 * closing the owner account all take effect on the next mint or introspection,
 * which is the same immediacy revoking a credential has.
 */
export interface LiveWorkloadPrincipal {
  readonly applicationId: string;
  /** `wl_…`, the value an attested token carries as its `credentialId`. */
  readonly handle: string;
  readonly scopes: readonly string[];
}

export interface ValidatedSubjectSession {
  readonly sessionId: string;
  readonly subjectAccountId: string;
  /** NULL is the shared first-party session every official app uses. */
  readonly applicationId: string | null;
  readonly accountStatus: string;
}

export interface LiveSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly applicationId: string | null;
  readonly accountStatus: string;
}

export interface RequesterAssertionSigning {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export type ReplayStoreResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'unavailable' };

export interface RequesterAssertionStore {
  /** Stores the record for `ttlSeconds`; refuses to overwrite an existing jti. */
  put(jti: string, record: RequesterAssertionRecord, ttlSeconds: number): Promise<ReplayStoreResult<boolean>>;
  /** Atomically reads and deletes. `value: null` when absent (never minted, expired or already used). */
  take(jti: string): Promise<ReplayStoreResult<RequesterAssertionRecord | null>>;
}

export interface RequesterAssertionDependencies {
  readonly issuer: string;
  readonly now: () => Date;
  readonly signing: () => RequesterAssertionSigning;
  /** Live app + credential + trust + owner state; `null` when no longer usable. */
  readonly resolvePrincipal: (applicationId: string, credentialId: string) => Promise<LiveServicePrincipal | null>;
  /**
   * The same question for an ATTESTED caller: live binding + app + trust + owner
   * state; `null` when no longer usable. Looked up by `(provider, subject)` —
   * the role, not the handle — because that is the unique key the binding table
   * is indexed on and the one an operator can read off a task definition.
   */
  readonly resolveWorkloadPrincipal: (
    applicationId: string,
    provider: AttestationProvider,
    subject: string,
  ) => Promise<LiveWorkloadPrincipal | null>;
  /** Full access-token validation (signature, expiry, row binding); `null` when invalid. */
  readonly validateSubjectToken: (token: string) => Promise<ValidatedSubjectSession | null>;
  /** The session row read past every cache; `null` when inactive, expired or revoked. */
  readonly loadLiveSession: (sessionId: string) => Promise<LiveSession | null>;
  readonly store: RequesterAssertionStore;
}

export type RequesterAssertionRefusal =
  | 'unknown_entry_point'
  | 'service_principal_not_live'
  | 'missing_inference_scope'
  | 'subject_session_invalid'
  | 'subject_session_not_live'
  | 'subject_session_other_application'
  | 'subject_account_inactive'
  | 'signing_unavailable'
  | 'replay_store_unavailable';

export type MintResult =
  | {
      readonly ok: true;
      readonly assertion: string;
      readonly expiresAt: string;
      readonly requesterAccountId: string;
      readonly agentId: string;
    }
  | { readonly ok: false; readonly reason: RequesterAssertionRefusal };

export type IntrospectionRefusal =
  | 'caller_not_audience'
  | OxyRequesterAssertionErrorCode
  | 'presenter_mismatch'
  | 'unknown_entry_point'
  | 'service_principal_not_live'
  | 'missing_inference_scope'
  | 'replay_store_unavailable'
  | 'not_found_or_replayed'
  | 'record_mismatch'
  | 'session_not_live'
  | 'session_account_mismatch'
  | 'session_other_application'
  | 'account_inactive';

export type IntrospectionResult =
  | {
      readonly active: true;
      readonly requesterAccountId: string;
      readonly agentId: string;
      readonly applicationId: string;
      readonly credentialId: string;
      readonly jti: string;
      readonly expiresAt: string;
    }
  | { readonly active: false; readonly reason: IntrospectionRefusal };

function sessionBelongsToApplication(sessionApplicationId: string | null, applicationId: string): boolean {
  return sessionApplicationId === null || sessionApplicationId === applicationId;
}

/**
 * The value the caller actually presented as its `credentialId`.
 *
 * Read off the match rather than off the request, so it is by construction one
 * of the two values the entry point admits.
 */
function presentedCredentialId(principal: NativeProductAgentPrincipal): string {
  return principal.kind === 'credential' ? principal.credentialId : principal.handle;
}

/**
 * The LIVE ceiling, on whichever row the caller actually has.
 *
 * A scope staff removed must not survive in an hour-old token, so the token's
 * own claims are never the last word — the row behind them is re-read on every
 * mint and every introspection. Which row that is depends on how the caller
 * proved itself, and the two must be equally strong:
 *
 *   * a credential-minted caller is its `ApplicationCredential`
 *     (`resolveLiveAgencyCoordinator`: active application, trusted, active
 *     owner, no closure fence, usable service credential);
 *   * an attested caller has no credential row at all and is its BINDING
 *     (`resolveLiveAgencyWorkload`: the same application, trust, owner and
 *     fence checks, plus an unexpired `application_workload_identities` row
 *     whose scopes are decided by the same `workloadBindingScopes` the mint
 *     used).
 *
 * Both then have to still name `inference:invoke`. Skipping the check for the
 * attested caller — on the grounds that there is no credential to check — would
 * make an attested token the one bearer no revocation reaches.
 */
async function liveEntryPrincipal(
  deps: RequesterAssertionDependencies,
  match: NativeProductAgentEntryPointMatch,
): Promise<'service_principal_not_live' | 'missing_inference_scope' | null> {
  const { entry, principal } = match;
  const live = principal.kind === 'credential'
    ? await deps.resolvePrincipal(entry.applicationId, principal.credentialId)
    : await deps.resolveWorkloadPrincipal(entry.applicationId, principal.provider, principal.subject);
  if (!live) return 'service_principal_not_live';
  if (!live.scopes.includes(REQUIRED_SERVICE_SCOPE)) return 'missing_inference_scope';
  return null;
}

/**
 * Mint for a product backend. `caller` must be the VERIFIED service token's
 * application and credential, never request input.
 */
export async function mintRequesterAssertion(
  deps: RequesterAssertionDependencies,
  input: {
    readonly caller: { readonly applicationId: string; readonly credentialId: string; readonly scopes: readonly string[] };
    readonly agentId: string;
    readonly subjectToken: string;
  },
): Promise<MintResult> {
  const match = nativeProductAgentEntryPoint(input.caller.applicationId, input.caller.credentialId, input.agentId);
  if (!match) return { ok: false, reason: 'unknown_entry_point' };
  const entry = match.entry;
  // The token's own scopes, then the live ceiling: a scope staff removed must
  // not survive in an hour-old token, and a scope never minted into the token
  // must not be conjured from the credential.
  if (!input.caller.scopes.includes(REQUIRED_SERVICE_SCOPE)) return { ok: false, reason: 'missing_inference_scope' };
  const principalRefusal = await liveEntryPrincipal(deps, match);
  if (principalRefusal) return { ok: false, reason: principalRefusal };

  const validated = await deps.validateSubjectToken(input.subjectToken);
  if (!validated) return { ok: false, reason: 'subject_session_invalid' };
  if (!sessionBelongsToApplication(validated.applicationId, entry.applicationId)) {
    return { ok: false, reason: 'subject_session_other_application' };
  }
  if (validated.accountStatus !== 'active') return { ok: false, reason: 'subject_account_inactive' };

  // `validateSubjectToken` may answer from a per-task cache. A sign-out on
  // another task must stop a mint now, not when that entry ages out.
  const live = await deps.loadLiveSession(validated.sessionId);
  if (!live || live.accountId !== validated.subjectAccountId) return { ok: false, reason: 'subject_session_not_live' };
  if (!sessionBelongsToApplication(live.applicationId, entry.applicationId)) {
    return { ok: false, reason: 'subject_session_other_application' };
  }
  if (live.accountStatus !== 'active') return { ok: false, reason: 'subject_account_inactive' };

  let signing: RequesterAssertionSigning;
  try {
    signing = deps.signing();
  } catch {
    return { ok: false, reason: 'signing_unavailable' };
  }

  const issuedAt = Math.floor(deps.now().getTime() / 1000);
  const claims: RequesterAssertionClaims = {
    iss: deps.issuer,
    aud: REQUESTER_ASSERTION_AUDIENCE,
    sub: validated.subjectAccountId,
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + REQUESTER_ASSERTION_TTL_SECONDS,
    azp: entry.applicationId,
    /**
     * WHAT CALLED, not what the entry point also admits.
     *
     * For a credential-minted caller this is the pinned credential id, exactly
     * as before. For an attested one it is the `wl_…` handle its token carries.
     * Naming the credential in an assertion a workload asked for would be a
     * claim about a credential that did not call and whose liveness was never
     * checked — and it would not work: every verifier of this claim, Oxy's own
     * `introspectRequesterAssertion` and `@oxy.so/core`'s
     * `requesterAssertion.ts` alike, compares `cid` to the PRESENTER's verified
     * service-token `credentialId`, which for an attested presenter is the
     * handle. An honest claim and a working one are the same claim here.
     */
    cid: presentedCredentialId(match.principal),
    agentId: entry.agentId,
  };
  const stored = await deps.store.put(claims.jti, {
    sessionId: validated.sessionId,
    requesterAccountId: claims.sub,
    applicationId: claims.azp,
    credentialId: claims.cid,
    agentId: claims.agentId,
  }, REQUESTER_ASSERTION_TTL_SECONDS);
  if (stored.status !== 'ok' || !stored.value) return { ok: false, reason: 'replay_store_unavailable' };

  return {
    ok: true,
    assertion: signOxyRequesterAssertion(claims, signing),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    requesterAccountId: claims.sub,
    agentId: claims.agentId,
  };
}

/**
 * Introspect and consume for the audience (Alia). `callerApplicationId` is the
 * VERIFIED service token's application; `presenter` is the verified service
 * identity that presented the assertion to Alia.
 */
export async function introspectRequesterAssertion(
  deps: RequesterAssertionDependencies,
  input: {
    readonly callerApplicationId: string;
    readonly audienceApplicationId: string;
    readonly assertion: string;
    readonly presenter: { readonly applicationId: string; readonly credentialId: string };
  },
): Promise<IntrospectionResult> {
  if (input.callerApplicationId !== input.audienceApplicationId) {
    return { active: false, reason: 'caller_not_audience' };
  }

  let claims: RequesterAssertionClaims;
  try {
    const signing = deps.signing();
    const keyId = readOxyRequesterAssertionKeyId(input.assertion);
    claims = verifyOxyRequesterAssertion(input.assertion, {
      publicKey: keyId === signing.keyId ? signing.publicKey : undefined,
      issuer: deps.issuer,
      audience: REQUESTER_ASSERTION_AUDIENCE,
      now: deps.now(),
    });
  } catch (error) {
    return {
      active: false,
      reason: error instanceof OxyRequesterAssertionError ? error.code : 'unknown_key',
    };
  }

  if (claims.azp !== input.presenter.applicationId || claims.cid !== input.presenter.credentialId) {
    return { active: false, reason: 'presenter_mismatch' };
  }
  const match = nativeProductAgentEntryPoint(claims.azp, claims.cid, claims.agentId);
  if (!match) return { active: false, reason: 'unknown_entry_point' };

  // Consumed BEFORE the live checks, so two concurrent presentations cannot both
  // pass them. A presentation that fails a later check has still spent the jti.
  const taken = await deps.store.take(claims.jti);
  if (taken.status !== 'ok') return { active: false, reason: 'replay_store_unavailable' };
  const record = taken.value;
  if (!record) return { active: false, reason: 'not_found_or_replayed' };
  if (
    record.requesterAccountId !== claims.sub
    || record.applicationId !== claims.azp
    || record.credentialId !== claims.cid
    || record.agentId !== claims.agentId
  ) {
    return { active: false, reason: 'record_mismatch' };
  }

  const principalRefusal = await liveEntryPrincipal(deps, match);
  if (principalRefusal) return { active: false, reason: principalRefusal };

  const live = await deps.loadLiveSession(record.sessionId);
  if (!live) return { active: false, reason: 'session_not_live' };
  if (live.accountId !== claims.sub) return { active: false, reason: 'session_account_mismatch' };
  if (!sessionBelongsToApplication(live.applicationId, claims.azp)) {
    return { active: false, reason: 'session_other_application' };
  }
  if (live.accountStatus !== 'active') return { active: false, reason: 'account_inactive' };

  return {
    active: true,
    requesterAccountId: claims.sub,
    agentId: claims.agentId,
    applicationId: claims.azp,
    credentialId: claims.cid,
    jti: claims.jti,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
