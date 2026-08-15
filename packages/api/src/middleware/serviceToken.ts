import jwt from 'jsonwebtoken';
import { OXY_SERVICE_ENVIRONMENTS, type OxyServiceEnvironment } from '@oxyhq/core/server';
import { logger } from '../utils/logger';

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

/**
 * Pure verification of a service JWT. SINGLE SOURCE OF TRUTH for the service
 * token contract — the blocking `serviceAuthMiddleware`, any optional /
 * dual-auth path, and the rate-limiter exemption verify through here so they
 * cannot drift. Performs the full `jwt.verify` (signature + expiry) and the
 * required-claim checks; never throws.
 */
export function verifyServiceToken(token: string): ServiceTokenVerification {
  if (!process.env.ACCESS_TOKEN_SECRET) {
    logger.error('ACCESS_TOKEN_SECRET not configured');
    return { ok: false, reason: 'invalid' };
  }

  let decoded: {
    type?: string;
    appId?: string;
    appName?: string;
    credentialId?: string;
    ownerAccountId?: string;
    environment?: unknown;
    scopes?: unknown;
    iat?: number;
    exp?: number;
    [key: string]: unknown;
  };
  try {
    decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET) as typeof decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: 'invalid' };
  }

  if (decoded.type !== 'service') {
    return { ok: false, reason: 'not_service' };
  }

  // Every field of the attribution tuple is REQUIRED. A signature-valid token
  // missing one is not a usable service principal: the alternative is a payload
  // with an optional `ownerAccountId`, and an optional billing principal is one
  // `?? something` away from being resolved from the wrong place.
  if (
    typeof decoded.appId !== 'string' ||
    typeof decoded.appName !== 'string' ||
    typeof decoded.credentialId !== 'string' ||
    decoded.credentialId.length === 0 ||
    typeof decoded.ownerAccountId !== 'string' ||
    decoded.ownerAccountId.length === 0 ||
    !isOxyServiceEnvironment(decoded.environment)
  ) {
    return { ok: false, reason: 'not_service' };
  }

  const scopes = Array.isArray(decoded.scopes)
    ? decoded.scopes.filter((s): s is string => typeof s === 'string')
    : [];

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
