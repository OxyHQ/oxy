import { createPublicKey, verify as verifyBytes } from 'node:crypto';
import {
  hasBoundedServiceTokenLifetime,
  OXY_SERVICE_ENVIRONMENTS,
  type OxyServiceEnvironment,
} from '@oxy.so/core/server';
import { OXY_API_AUDIENCE, type ServiceTokenAudience } from '../config/serviceTokenAudiences';
import { serviceTokenPublicJwks } from '../config/serviceTokenSigning';

/**
 * Service-token verification — the pure JWT half of the service-auth contract.
 *
 * Kept in its OWN module (importing only `node:crypto`, the shared environment
 * vocabulary and the public signing keys) so it can be reused by request-path code — the
 * blocking `serviceAuthMiddleware`, the optional/dual-auth path, and the
 * rate-limiter's service-to-service exemption predicate — WITHOUT dragging in
 * the session-service / schema graph that `middleware/auth.ts` pulls in.
 * `verifyServiceToken` is the SINGLE SOURCE OF TRUTH for the service-token
 * contract; every consumer verifies through here.
 *
 * The environment vocabulary comes from `@oxy.so/core/server` rather than the
 * drizzle schema on purpose: `@oxy.so/core`'s own service-token verification
 * narrows against the same tuple, so the API's verifier and the SDK's cannot
 * disagree about which environments exist, and this module keeps its
 * schema-free dependency shape.
 */

/**
 * Signed service attribution: application, workload/credential, owning account,
 * environment and audience. First-party workload authority has no scopes;
 * external credentials carry bounded scopes. Signature verification alone does
 * not establish live authority: receivers must resolve the registered principal.
 *
 * A requester account is separate from billing attribution. A user-id header
 * alone cannot establish it; session, task, capability or chained requester proof
 * is validated per request before accessing personal resources (ADR 0049).
 */
/** Legacy wire metadata only. Never infer authority from tier or application branding. */
export type ServiceTier = 'internal' | 'external';

export interface ServiceTokenPayload {
  type: 'service';
  appId: string;
  appName: string;
  /** The specific ApplicationCredential `_id` that minted this token. */
  credentialId: string;
  /**
   * The Oxy account that owns `appId` and is financially responsible for it
   * (`applications.owner_account_id`). The BILLING principal — never a user id,
   * and never the delegated `X-Oxy-User-Id` (ADR 0007).
   */
  ownerAccountId: string;
  /** Test/live isolation: the minting `ApplicationCredential.environment`. */
  environment: OxyServiceEnvironment;
  /** See {@link ServiceTier}. */
  tier: ServiceTier;
  authority?: 'first_party' | 'external';
  scopes?: string[];
  audience?: string;
  iat?: number;
  exp?: number;
}

/** Narrow an unverified claim to the shared environment vocabulary. */
function isOxyServiceEnvironment(value: unknown): value is OxyServiceEnvironment {
  return (
    typeof value === 'string' && (OXY_SERVICE_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * Outcome of {@link verifyServiceToken}. The verification is deliberately
 * tri-state so callers can produce the precise 4xx (blocking middleware) or
 * silently fall back to anonymous (non-blocking optional auth):
 *  - `{ ok: true, payload }` — a valid `service`-type token.
 *  - `{ ok: false, reason: 'not_service' }` — not a service token: signed with
 *    anything other than EdDSA (a user session token — unverified, since this
 *    module holds no user key), or a verified token missing service claims.
 *  - `{ ok: false, reason: 'expired' | 'invalid' }` — verification failed.
 */
export type ServiceTokenVerification =
  | { ok: true; payload: ServiceTokenPayload }
  | { ok: false; reason: 'not_service' | 'expired' | 'invalid' };

type UnverifiedServiceClaims = {
  type?: string;
  appId?: string;
  appName?: string;
  credentialId?: string;
  ownerAccountId?: string;
  environment?: unknown;
  tier?: unknown;
  authority?: unknown;
  scopes?: unknown;
  iss?: unknown;
  aud?: unknown;
  iat?: number;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid base64url');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('non-canonical base64url');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function verifyEd25519ServiceToken(token: string): UnverifiedServiceClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  try {
    const header = decodeSegment(headerSegment);
    if (typeof header !== 'object' || header === null || Array.isArray(header)) return null;
    const record = header as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      record.alg !== 'EdDSA' ||
      record.typ !== 'JWT' ||
      typeof record.kid !== 'string' ||
      record.kid.length === 0
    )
      return null;
    const jwk = serviceTokenPublicJwks().find((candidate) => candidate.kid === record.kid);
    if (!jwk) return null;
    const signature = Buffer.from(signatureSegment, 'base64url');
    if (signature.toString('base64url') !== signatureSegment || signature.length !== 64)
      return null;
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verifyBytes(null, Buffer.from(`${headerSegment}.${payloadSegment}`), publicKey, signature))
      return null;
    const payload = decodeSegment(payloadSegment);
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as UnverifiedServiceClaims)
      : null;
  } catch {
    return null;
  }
}

/**
 * Pure verification of a service JWT. SINGLE SOURCE OF TRUTH for the service
 * token contract — the blocking `serviceAuthMiddleware`, any optional /
 * dual-auth path, and the rate-limiter exemption verify through here so they
 * cannot drift. Verifies the EdDSA signature against the published key named by `kid`,
 * then expiry, issuer, audience and the
 * required-claim checks; never throws.
 *
 * `audience` defaults to Oxy's own API: every existing caller keeps refusing a
 * token minted for `kaana.ai` or Kaana's control plane, and the grant API asks
 * for exactly the audience it serves (`config/serviceTokenAudiences.ts`).
 */
export function verifyServiceToken(
  token: string,
  audience: ServiceTokenAudience = OXY_API_AUDIENCE,
): ServiceTokenVerification {
  let header: { alg?: unknown } | null = null;
  try {
    const candidate = decodeSegment(token.split('.')[0] ?? '');
    header =
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
        ? (candidate as { alg?: unknown })
        : null;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  // EdDSA is the only algorithm a service token is ever signed with (ADR 0012).
  // Any other `alg` — a user access token, or an HS256 token claiming
  // `type: 'service'` under any secret — is not a service token, and nothing
  // in it is read. A caller that answers `not_service` with 403 keeps doing so
  // for a user token; one that falls through to session auth still does.
  if (header?.alg !== 'EdDSA') {
    return { ok: false, reason: 'not_service' };
  }
  const decoded = verifyEd25519ServiceToken(token);
  if (!decoded) {
    return { ok: false, reason: 'invalid' };
  }

  if (decoded.type !== 'service') {
    return { ok: false, reason: 'not_service' };
  }

  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(decoded.exp) || (decoded.exp as number) <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (
    decoded.iss !== 'oxy-auth' ||
    !(decoded.aud === audience || (Array.isArray(decoded.aud) && decoded.aud.includes(audience))) ||
    (decoded.nbf !== undefined && (!Number.isInteger(decoded.nbf) || decoded.nbf > now)) ||
    !hasBoundedServiceTokenLifetime(decoded, now)
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // Every field of the attribution tuple is REQUIRED. A signature-valid token
  // missing one is not a usable service principal: the alternative is a payload
  // with an optional `ownerAccountId`, and an optional billing principal is one
  // `?? something` away from being resolved from the wrong place.
  if (
    !isExactNonEmptyString(decoded.appId) ||
    !isExactNonEmptyString(decoded.appName) ||
    !isExactNonEmptyString(decoded.credentialId) ||
    !isExactNonEmptyString(decoded.ownerAccountId) ||
    !isOxyServiceEnvironment(decoded.environment)
  ) {
    return { ok: false, reason: 'not_service' };
  }

  const firstParty = decoded.authority === 'first_party';
  if (firstParty) {
    if (
      decoded.scopes !== undefined ||
      !/^wl_[a-f0-9]{24}$/.test(decoded.credentialId) ||
      decoded.tier !== 'internal' ||
      decoded.aud !== audience
    ) {
      return { ok: false, reason: 'invalid' };
    }
  } else if (
    (decoded.authority !== undefined && decoded.authority !== 'external') ||
    !Array.isArray(decoded.scopes) ||
    !decoded.scopes.every((scope) => isExactNonEmptyString(scope)) ||
    new Set(decoded.scopes).size !== decoded.scopes.length
  )
    return { ok: false, reason: 'invalid' };

  return {
    ok: true,
    payload: {
      type: 'service',
      appId: decoded.appId,
      appName: decoded.appName,
      credentialId: decoded.credentialId,
      ownerAccountId: decoded.ownerAccountId,
      environment: decoded.environment,
      tier: decoded.tier === 'internal' ? 'internal' : 'external',
      authority: firstParty ? 'first_party' : 'external',
      // Preserve exact audience provenance; an accepted legacy audience array is not an exact recipient.
      audience: typeof decoded.aud === 'string' ? decoded.aud : undefined,
      ...(firstParty ? {} : { scopes: decoded.scopes as string[] }),
      iat: decoded.iat,
      exp: decoded.exp,
    },
  };
}
