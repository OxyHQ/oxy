import { createPublicKey, verify as verifyBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { OXY_SERVICE_ENVIRONMENTS, type OxyServiceEnvironment } from '@oxyhq/core/server';
import { serviceTokenPublicJwks } from '../config/serviceTokenSigning';

/**
 * Service-token verification — the pure JWT half of the service-auth contract.
 *
 * Kept in its OWN module (importing only `jsonwebtoken`, the shared environment
 * vocabulary and `logger`) so it can be reused by request-path code — the
 * blocking `serviceAuthMiddleware`, the optional/dual-auth path, and the
 * rate-limiter's service-to-service exemption predicate — WITHOUT dragging in
 * the session-service / schema graph that `middleware/auth.ts` pulls in.
 * `verifyServiceToken` is the SINGLE SOURCE OF TRUTH for the service-token
 * contract; every consumer verifies through here.
 *
 * The environment vocabulary comes from `@oxyhq/core/server` rather than the
 * drizzle schema on purpose: `@oxyhq/core`'s own service-token verification
 * narrows against the same tuple, so the API's verifier and the SDK's cannot
 * disagree about which environments exist, and this module keeps its
 * schema-free dependency shape.
 */

/**
 * Decoded payload for service-to-service JWTs minted via
 * `POST /auth/service-token`. Carries the `scopes` granted to the Application so
 * downstream middleware can do per-scope authorisation. The `appId` claim is the
 * Application `_id`.
 *
 * This is the whole canonical attribution tuple of ADR 0007 minus the delegated
 * user: application, credential and the OWNING ACCOUNT, all resolved server-side
 * at mint time from the presented credential. A verifier holding a valid token
 * can therefore name the financially responsible principal with no lookup.
 *
 * A delegated end user is deliberately ABSENT from this type. It arrives as the
 * `X-Oxy-User-Id` header, is authorised per request, and is attribution only —
 * see `resolveViewerId` in `middleware/optionalAuth.ts`. Nothing here may ever
 * hold it, because a field on this payload is exactly what code reaches for when
 * it wants "who is responsible for this request".
 */
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
  scopes: string[];
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
 *  - `{ ok: false, reason: 'not_service' }` — verified, but not a service token
 *    (a user session token, or missing required service claims).
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
      Object.keys(record).length !== 3
      || record.alg !== 'EdDSA'
      || record.typ !== 'JWT'
      || typeof record.kid !== 'string'
      || record.kid.length === 0
    ) return null;
    const jwk = serviceTokenPublicJwks().find((candidate) => candidate.kid === record.kid);
    if (!jwk) return null;
    const signature = Buffer.from(signatureSegment, 'base64url');
    if (signature.toString('base64url') !== signatureSegment || signature.length !== 64) return null;
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verifyBytes(null, Buffer.from(`${headerSegment}.${payloadSegment}`), publicKey, signature)) return null;
    const payload = decodeSegment(payloadSegment);
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as UnverifiedServiceClaims
      : null;
  } catch {
    return null;
  }
}

/**
 * Pure verification of a service JWT. SINGLE SOURCE OF TRUTH for the service
 * token contract — the blocking `serviceAuthMiddleware`, any optional /
 * dual-auth path, and the rate-limiter exemption verify through here so they
 * cannot drift. Performs the full `jwt.verify` (signature + expiry) and the
 * required-claim checks; never throws.
 */
export function verifyServiceToken(token: string): ServiceTokenVerification {
  let header: { alg?: unknown } | null = null;
  try {
    const candidate = decodeSegment(token.split('.')[0] ?? '');
    header = typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? candidate as { alg?: unknown }
      : null;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  let decoded: UnverifiedServiceClaims | null = null;
  if (header?.alg === 'EdDSA') {
    decoded = verifyEd25519ServiceToken(token);
  } else if (header?.alg === 'HS256' && process.env.ACCESS_TOKEN_SECRET) {
    try {
      decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, {
        algorithms: ['HS256'],
        issuer: 'oxy-auth',
        audience: 'oxy-api',
      }) as UnverifiedServiceClaims;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
      return { ok: false, reason: 'invalid' };
    }
  }
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
    decoded.iss !== 'oxy-auth'
    || !(decoded.aud === 'oxy-api' || (Array.isArray(decoded.aud) && decoded.aud.includes('oxy-api')))
    || (decoded.nbf !== undefined && (!Number.isInteger(decoded.nbf) || decoded.nbf > now))
    || (decoded.iat !== undefined && !Number.isInteger(decoded.iat))
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
    !isOxyServiceEnvironment(decoded.environment) ||
    !Array.isArray(decoded.scopes) ||
    !decoded.scopes.every((scope) => typeof scope === 'string' && scope.length > 0 && scope === scope.trim()) ||
    new Set(decoded.scopes).size !== decoded.scopes.length
  ) {
    return { ok: false, reason: 'not_service' };
  }

  const scopes = decoded.scopes as string[];

  return {
    ok: true,
    payload: {
      type: 'service',
      appId: decoded.appId,
      appName: decoded.appName,
      credentialId: decoded.credentialId,
      ownerAccountId: decoded.ownerAccountId,
      environment: decoded.environment,
      scopes,
      iat: decoded.iat,
      exp: decoded.exp,
    },
  };
}
