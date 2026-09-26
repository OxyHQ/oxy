/**
 * Present-requester assertions (ADR 0025).
 *
 * A first-party product backend holding a signed-in person's live Oxy session
 * trades it with Oxy (`server.agency.mintRequesterAssertion`) for a one-use,
 * short-lived `OXY-REQUESTER+JWT`, and sends that — never the person's bearer —
 * to the audience service (Alia) beside its own service token. The audience
 * mounts {@link createOxyRequesterAssertionAuth} after `createOxyAuthMiddleware`
 * and gets `req.userId` from the verified, introspected and consumed assertion.
 *
 * Signing and stateless verification live here so Oxy (the signer) and every
 * verifier share one implementation of the format.
 */

import {
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest, OxyServiceAppContext } from './auth';

export const OXY_REQUESTER_ASSERTION_TYPE = 'OXY-REQUESTER+JWT';
/** The request header an audience reads the assertion from. */
export const OXY_REQUESTER_ASSERTION_HEADER = 'x-oxy-requester-assertion';
/** Oxy signs for 120 s; no verifier accepts a lifetime above this ceiling. */
export const OXY_REQUESTER_ASSERTION_MAX_TTL_SECONDS = 300;
export const OXY_REQUESTER_ASSERTION_DEFAULT_ISSUER = 'https://api.oxy.so';

const ALGORITHM = 'EdDSA';
const CLOCK_SKEW_SECONDS = 5;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ASSERTION_BYTES = 4096;

const identifier = z.string().min(1).max(128);

export const oxyRequesterAssertionClaimsSchema = z.object({
  iss: z.string().min(1).max(256),
  aud: identifier,
  /** The requester account. */
  sub: identifier,
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  /** The application the assertion was minted for, and the only valid presenter. */
  azp: identifier,
  /** The exact credential of that application. */
  cid: identifier,
  /** The one native agent this requester may reach with it. */
  agentId: identifier,
}).strict();

export type OxyRequesterAssertionClaims = z.infer<typeof oxyRequesterAssertionClaimsSchema>;

export type OxyRequesterAssertionErrorCode =
  | 'malformed'
  | 'unknown_key'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'not_yet_valid'
  | 'expired'
  | 'ttl_exceeded';

export class OxyRequesterAssertionError extends Error {
  constructor(public readonly code: OxyRequesterAssertionErrorCode) {
    super(`Requester assertion rejected: ${code}`);
    this.name = 'OxyRequesterAssertionError';
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeObject(segment: string): Record<string, unknown> {
  if (!BASE64URL_PATTERN.test(segment)) throw new OxyRequesterAssertionError('malformed');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new OxyRequesterAssertionError('malformed');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new OxyRequesterAssertionError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OxyRequesterAssertionError('malformed');
  }
  return value as Record<string, unknown>;
}

/** Signs an assertion. Oxy is the only intended caller. */
export function signOxyRequesterAssertion(
  claims: OxyRequesterAssertionClaims,
  signing: { readonly keyId: string; readonly privateKey: KeyObject },
): string {
  const parsed = oxyRequesterAssertionClaimsSchema.parse(claims);
  if (parsed.exp <= parsed.iat || parsed.exp - parsed.iat > OXY_REQUESTER_ASSERTION_MAX_TTL_SECONDS) {
    throw new OxyRequesterAssertionError('ttl_exceeded');
  }
  if (!KEY_ID_PATTERN.test(signing.keyId)) throw new OxyRequesterAssertionError('malformed');
  if (signing.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new OxyRequesterAssertionError('unknown_key');
  }
  const header = { alg: ALGORITHM, typ: OXY_REQUESTER_ASSERTION_TYPE, kid: signing.keyId };
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(parsed))}`;
  return `${input}.${base64Url(signBytes(null, Buffer.from(input), signing.privateKey))}`;
}

/** Reads the `kid` without trusting anything else in the token. */
export function readOxyRequesterAssertionKeyId(token: string): string {
  if (token.length > MAX_ASSERTION_BYTES) throw new OxyRequesterAssertionError('malformed');
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new OxyRequesterAssertionError('malformed');
  }
  const header = decodeObject(segments[0] as string);
  if (
    Object.keys(header).length !== 3
    || header.alg !== ALGORITHM
    || header.typ !== OXY_REQUESTER_ASSERTION_TYPE
    || typeof header.kid !== 'string'
    || !KEY_ID_PATTERN.test(header.kid)
  ) {
    throw new OxyRequesterAssertionError('malformed');
  }
  return header.kid;
}

export interface OxyRequesterAssertionVerificationOptions {
  readonly publicKey: KeyObject | undefined;
  readonly issuer: string;
  readonly audience: string;
  readonly now?: Date;
}

/**
 * Stateless verification: header, signature, claim shape, issuer, audience and
 * lifetime. It does NOT prove the assertion is unused or that the requester's
 * session is still live — only introspection does.
 */
export function verifyOxyRequesterAssertion(
  token: string,
  options: OxyRequesterAssertionVerificationOptions,
): OxyRequesterAssertionClaims {
  readOxyRequesterAssertionKeyId(token);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [string, string, string];
  const publicKey = options.publicKey;
  if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new OxyRequesterAssertionError('unknown_key');
  }
  if (!BASE64URL_PATTERN.test(encodedSignature)) throw new OxyRequesterAssertionError('malformed');
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== encodedSignature) {
    throw new OxyRequesterAssertionError('malformed');
  }
  if (!verifyBytes(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, signature)) {
    throw new OxyRequesterAssertionError('invalid_signature');
  }

  const parsed = oxyRequesterAssertionClaimsSchema.safeParse(decodeObject(encodedPayload));
  if (!parsed.success) throw new OxyRequesterAssertionError('invalid_claims');
  const claims = parsed.data;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== options.issuer) throw new OxyRequesterAssertionError('wrong_issuer');
  if (claims.aud !== options.audience) throw new OxyRequesterAssertionError('wrong_audience');
  if (claims.iat > now + CLOCK_SKEW_SECONDS) throw new OxyRequesterAssertionError('not_yet_valid');
  if (claims.exp <= now) throw new OxyRequesterAssertionError('expired');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > OXY_REQUESTER_ASSERTION_MAX_TTL_SECONDS) {
    throw new OxyRequesterAssertionError('ttl_exceeded');
  }
  return claims;
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

const JWKS_CACHE_MS = 5 * 60 * 1000;
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 20;

function parseJwks(value: unknown): Map<string, KeyObject> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JWKS is malformed');
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > JWKS_MAX_KEYS) throw new Error('JWKS has an invalid key set');
  const result = new Map<string, KeyObject>();
  for (const entry of keys) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('JWKS key is malformed');
    const key = entry as Record<string, unknown>;
    if (
      key.kty !== 'OKP'
      || key.crv !== 'Ed25519'
      || key.alg !== 'EdDSA'
      || key.use !== 'sig'
      || typeof key.x !== 'string'
      || typeof key.kid !== 'string'
      || !KEY_ID_PATTERN.test(key.kid)
      || Object.prototype.hasOwnProperty.call(key, 'd')
      || result.has(key.kid)
    ) throw new Error('JWKS key is unsupported');
    const x = Buffer.from(key.x, 'base64url');
    if (x.length !== 32 || x.toString('base64url') !== key.x) throw new Error('JWKS key is not Ed25519');
    result.set(key.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }));
  }
  return result;
}

export interface OxyJwksKeyResolverOptions {
  readonly jwksUrl: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
}

/**
 * Cached Ed25519 JWKS resolver. An unknown `kid` refreshes at most once a
 * minute, so a flood of forged key ids cannot turn into a flood of fetches. A
 * failed refresh keeps serving keys that are still inside their cache window.
 */
export function createOxyJwksKeyResolver(
  options: OxyJwksKeyResolverOptions,
): (keyId: string) => Promise<KeyObject | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    if (pending) return pending;
    lastAttemptAt = clock();
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(options.jwksUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`JWKS returned HTTP ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > JWKS_MAX_BYTES) throw new Error('JWKS exceeds the size limit');
        keys = parseJwks(JSON.parse(body) as unknown);
        expiresAt = clock() + JWKS_CACHE_MS;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };

  return async (keyId: string) => {
    const now = clock();
    const cached = keys.get(keyId);
    if (cached && expiresAt > now) return cached;
    if (expiresAt <= now || now - lastAttemptAt >= JWKS_REFRESH_FLOOR_MS) {
      try {
        await refresh();
      } catch {
        // Fall through: a still-valid cached key is served, anything else is unknown.
      }
    }
    return expiresAt > clock() ? keys.get(keyId) : undefined;
  };
}

// ---------------------------------------------------------------------------
// Audience middleware
// ---------------------------------------------------------------------------

export interface OxyRequesterAssertionIntrospection {
  readonly active: boolean;
  readonly requesterAccountId?: string;
  readonly agentId?: string;
  readonly applicationId?: string;
  readonly credentialId?: string;
  readonly jti?: string;
  readonly expiresAt?: string;
}

/** What the audience middleware needs of its `OxyServer`. */
export interface OxyRequesterAssertionIntrospector {
  readonly baseURL: string;
  readonly agency: {
    introspectRequesterAssertion(input: {
      assertion: string;
      presenter: { applicationId: string; credentialId: string };
    }): Promise<OxyRequesterAssertionIntrospection>;
  };
}

/** What the audience learns about the present requester. */
export interface OxyRequesterContext {
  readonly userId: string;
  readonly agentId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly jti: string;
  readonly expiresAt: string;
}

export interface OxyRequesterAssertionRequest extends OxyAuthRequest {
  oxyRequester?: OxyRequesterContext;
}

export interface OxyRequesterAssertionAuthOptions {
  /** This service's audience name, e.g. `alia`. */
  readonly audience: string;
  /** Defaults to `https://api.oxy.so`. */
  readonly issuer?: string;
  /** Defaults to `/capabilities/.well-known/jwks.json` on the introspector's origin. */
  readonly jwksUrl?: string;
  readonly resolvePublicKey?: (keyId: string) => Promise<KeyObject | undefined>;
  readonly now?: () => Date;
  /** Observability hook. Receives ids only, never the assertion. */
  readonly onRejected?: (event: {
    readonly code: string;
    readonly status: number;
    readonly applicationId: string | null;
  }) => void;
}

function reject(
  req: Request,
  res: Response,
  options: OxyRequesterAssertionAuthOptions,
  status: 400 | 401 | 503,
  error: string,
  code: string,
): void {
  options.onRejected?.({
    code,
    status,
    applicationId: (req as OxyAuthRequest).serviceApp?.appId ?? null,
  });
  res.status(status).json({ error, code, message: 'The requester assertion was not accepted', status });
}

function singleHeader(req: Request, name: string): string | null | 'invalid' {
  const value = req.headers[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ASSERTION_BYTES) return 'invalid';
  return value;
}

/**
 * Accepts an `X-Oxy-Requester-Assertion` presented beside a VERIFIED service
 * token. Mount it after `createOxyAuthMiddleware`. Without the header it does
 * nothing, so it composes with every other lane.
 *
 * `introspector` is this service's `OxyServer`, holding THIS service's own
 * credential: Oxy only lets the audience's application
 * consume an assertion.
 */
export function createOxyRequesterAssertionAuth(
  introspector: OxyRequesterAssertionIntrospector,
  options: OxyRequesterAssertionAuthOptions,
): RequestHandler {
  const issuer = options.issuer ?? OXY_REQUESTER_ASSERTION_DEFAULT_ISSUER;
  let resolvePublicKey = options.resolvePublicKey;
  const resolver = (): ((keyId: string) => Promise<KeyObject | undefined>) => {
    resolvePublicKey ??= createOxyJwksKeyResolver({
      jwksUrl: options.jwksUrl
        ?? new URL('/capabilities/.well-known/jwks.json', introspector.baseURL).toString(),
    });
    return resolvePublicKey;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const assertion = singleHeader(req, OXY_REQUESTER_ASSERTION_HEADER);
    if (assertion === null) {
      next();
      return;
    }
    if (assertion === 'invalid') {
      reject(req, res, options, 401, 'REQUESTER_ASSERTION_INVALID', 'malformed');
      return;
    }

    const request = req as OxyRequesterAssertionRequest;
    const serviceApp: OxyServiceAppContext | undefined = request.serviceApp;
    if (!serviceApp) {
      reject(req, res, options, 401, 'REQUESTER_ASSERTION_REQUIRES_SERVICE_TOKEN', 'service_token_required');
      return;
    }
    // One identity channel per request. An offline delegation header or an
    // identity some earlier middleware attached must never be combined with, or
    // silently replaced by, a present-requester assertion.
    if (
      req.headers['x-oxy-user-id'] !== undefined
      || request.serviceActingAs !== undefined
      || (request.userId !== undefined && request.userId !== null)
    ) {
      reject(req, res, options, 400, 'REQUESTER_ASSERTION_CONFLICT', 'identity_conflict');
      return;
    }

    let claims: OxyRequesterAssertionClaims;
    try {
      const keyId = readOxyRequesterAssertionKeyId(assertion);
      claims = verifyOxyRequesterAssertion(assertion, {
        publicKey: await resolver()(keyId),
        issuer,
        audience: options.audience,
        ...(options.now ? { now: options.now() } : {}),
      });
    } catch (error) {
      const code = error instanceof OxyRequesterAssertionError ? error.code : 'invalid_claims';
      reject(req, res, options, 401, 'REQUESTER_ASSERTION_INVALID', code);
      return;
    }

    // Bound to its presenter: a copy in anyone else's hands proves nothing,
    // and checking before introspection means it cannot even be spent.
    if (claims.azp !== serviceApp.appId || claims.cid !== serviceApp.credentialId) {
      reject(req, res, options, 401, 'REQUESTER_ASSERTION_INVALID', 'presenter_mismatch');
      return;
    }

    let introspection: OxyRequesterAssertionIntrospection;
    try {
      introspection = await introspector.agency.introspectRequesterAssertion({
        assertion,
        presenter: { applicationId: serviceApp.appId, credentialId: serviceApp.credentialId },
      });
    } catch {
      reject(req, res, options, 503, 'REQUESTER_ASSERTION_UNAVAILABLE', 'introspection_unavailable');
      return;
    }

    if (
      introspection.active !== true
      || introspection.requesterAccountId !== claims.sub
      || introspection.agentId !== claims.agentId
      || introspection.applicationId !== claims.azp
      || introspection.credentialId !== claims.cid
      || introspection.jti !== claims.jti
    ) {
      reject(req, res, options, 401, 'REQUESTER_ASSERTION_INACTIVE', 'inactive');
      return;
    }

    request.userId = claims.sub;
    request.user = { id: claims.sub };
    request.oxyRequester = {
      userId: claims.sub,
      agentId: claims.agentId,
      applicationId: claims.azp,
      credentialId: claims.cid,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    next();
  };
}
