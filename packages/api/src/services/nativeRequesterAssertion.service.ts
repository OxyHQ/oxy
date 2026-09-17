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
 * MINT proves, live: the calling credential is one pinned entry point for the
 * named agent; the application and credential are still live and trusted with
 * `inference:invoke`; the presented access token is a valid, bound, live session
 * whose owner account is active; and that session is the shared first-party
 * session or the calling application's own. The session id and requester are
 * stored server-side under the `jti`, never placed in the token.
 *
 * INTROSPECT proves, live and exactly once: the token is ours, for Alia, and is
 * being presented by the application and credential it was minted for; the
 * entry point and the product principal are still live; the server-side record
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
  type NativeProductAgentEntryPoint,
} from '../config/nativeProductAgents';

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

async function liveEntryPrincipal(
  deps: RequesterAssertionDependencies,
  entry: NativeProductAgentEntryPoint,
): Promise<'service_principal_not_live' | 'missing_inference_scope' | null> {
  const principal = await deps.resolvePrincipal(entry.applicationId, entry.credentialId);
  if (!principal) return 'service_principal_not_live';
  if (!principal.scopes.includes(REQUIRED_SERVICE_SCOPE)) return 'missing_inference_scope';
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
  const entry = nativeProductAgentEntryPoint(input.caller.applicationId, input.caller.credentialId, input.agentId);
  if (!entry) return { ok: false, reason: 'unknown_entry_point' };
  // The token's own scopes, then the live ceiling: a scope staff removed must
  // not survive in an hour-old token, and a scope never minted into the token
  // must not be conjured from the credential.
  if (!input.caller.scopes.includes(REQUIRED_SERVICE_SCOPE)) return { ok: false, reason: 'missing_inference_scope' };
  const principalRefusal = await liveEntryPrincipal(deps, entry);
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
    cid: entry.credentialId,
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
  const entry = nativeProductAgentEntryPoint(claims.azp, claims.cid, claims.agentId);
  if (!entry) return { active: false, reason: 'unknown_entry_point' };

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

  const principalRefusal = await liveEntryPrincipal(deps, entry);
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
