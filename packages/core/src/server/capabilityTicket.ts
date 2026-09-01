import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  capabilityTicketClaimsSchema,
  type CapabilityTicketClaims,
  type GrantLimit,
  type PolicyDecision,
} from '@oxyhq/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const HEADER = { alg: 'HS256', typ: 'OXY-CAPABILITY+JWT' } as const;
const DEFAULT_MAX_TTL_SECONDS = 300;

type UnsignedCapabilityTicketClaims = Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'>;

export interface CapabilityTicketSigningOptions {
  secret: string | Uint8Array;
  issuer: string;
  ttlSeconds?: number;
  now?: Date;
  jti?: string;
}

export interface CapabilityTicketVerificationOptions {
  secret: string | Uint8Array;
  audience: string;
  issuer?: string;
  now?: Date;
  maximumTtlSeconds?: number;
}

export interface CapabilityTicketRequest extends Request {
  capabilityTicket?: CapabilityTicketClaims;
}

export interface CapabilityTicketMiddlewareOptions extends CapabilityTicketVerificationOptions {
  authorize: (claims: CapabilityTicketClaims) => Promise<PolicyDecision>;
}

export class CapabilityTicketError extends Error {
  constructor(
    public readonly code:
      | 'malformed'
      | 'invalid_signature'
      | 'invalid_claims'
      | 'expired'
      | 'not_yet_valid'
      | 'wrong_audience'
      | 'wrong_issuer'
      | 'ttl_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityTicketError';
  }
}

function base64UrlEncode(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new CapabilityTicketError('malformed', 'Capability ticket is not valid base64url JSON');
  }
}

function sign(input: string, secret: string | Uint8Array): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Enforces the signed per-action bounds before a domain handler runs. */
export function inputSatisfiesCapabilityLimits(
  input: Record<string, unknown>,
  limits: readonly GrantLimit[],
): boolean {
  for (const limit of limits) {
    const actual = valueAtPath(input, limit.key);
    if (actual === undefined) continue;
    if (typeof limit.value === 'number') {
      if (typeof actual !== 'number' || !Number.isFinite(actual) || actual > limit.value) return false;
      continue;
    }
    if (Array.isArray(limit.value)) {
      const allowedValues = limit.value;
      if (typeof actual === 'string' && !allowedValues.includes(actual)) return false;
      if (Array.isArray(actual) && !actual.every((entry) => typeof entry === 'string' && allowedValues.includes(entry))) return false;
      if (typeof actual !== 'string' && !Array.isArray(actual)) return false;
      continue;
    }
    if (actual !== limit.value) return false;
  }
  return true;
}

export function issueCapabilityTicket(
  claims: UnsignedCapabilityTicketClaims,
  options: CapabilityTicketSigningOptions,
): string {
  const ttlSeconds = options.ttlSeconds ?? 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > DEFAULT_MAX_TTL_SECONDS) {
    throw new CapabilityTicketError('ttl_exceeded', `Capability ticket TTL must be between 1 and ${DEFAULT_MAX_TTL_SECONDS} seconds`);
  }

  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const payload = capabilityTicketClaimsSchema.parse({
    ...claims,
    iss: options.issuer,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: options.jti ?? randomUUID(),
  });
  const signingInput = `${base64UrlEncode(JSON.stringify(HEADER))}.${base64UrlEncode(JSON.stringify(payload))}`;
  return `${signingInput}.${base64UrlEncode(sign(signingInput, options.secret))}`;
}

export function verifyCapabilityTicket(
  token: string,
  options: CapabilityTicketVerificationOptions,
): CapabilityTicketClaims {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new CapabilityTicketError('malformed', 'Capability ticket must have three segments');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new CapabilityTicketError('malformed', 'Capability ticket contains an empty segment');
  }

  const header = decodeJsonSegment(encodedHeader);
  if (
    typeof header !== 'object'
    || header === null
    || !('alg' in header)
    || !('typ' in header)
    || header.alg !== HEADER.alg
    || header.typ !== HEADER.typ
  ) {
    throw new CapabilityTicketError('malformed', 'Capability ticket header is not supported');
  }

  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`, options.secret);
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new CapabilityTicketError('malformed', 'Capability ticket signature is malformed');
  }
  if (
    providedSignature.length !== expectedSignature.length
    || !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new CapabilityTicketError('invalid_signature', 'Capability ticket signature is invalid');
  }

  const parsed = capabilityTicketClaimsSchema.safeParse(decodeJsonSegment(encodedPayload));
  if (!parsed.success) {
    throw new CapabilityTicketError('invalid_claims', 'Capability ticket claims are invalid');
  }

  const claims = parsed.data;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if (claims.iat > now + 5) {
    throw new CapabilityTicketError('not_yet_valid', 'Capability ticket is not yet valid');
  }
  if (claims.exp <= now) {
    throw new CapabilityTicketError('expired', 'Capability ticket has expired');
  }
  if (claims.exp - claims.iat > (options.maximumTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS)) {
    throw new CapabilityTicketError('ttl_exceeded', 'Capability ticket lifetime exceeds the accepted maximum');
  }
  if (claims.aud !== options.audience) {
    throw new CapabilityTicketError('wrong_audience', 'Capability ticket audience does not match this app');
  }
  if (options.issuer && claims.iss !== options.issuer) {
    throw new CapabilityTicketError('wrong_issuer', 'Capability ticket issuer is not trusted');
  }

  return claims;
}

export function readCapabilityAuthorization(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token, extra] = authorization.trim().split(/\s+/);
  if (scheme !== 'Capability' || !token || extra) return null;
  return token;
}

/**
 * Verifies cryptographic scope first, then asks the authority service for a
 * live decision. This second check is what makes revocation effective between
 * planning and execution.
 */
export function createCapabilityTicketMiddleware(
  options: CapabilityTicketMiddlewareOptions,
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const token = readCapabilityAuthorization(request.header('authorization'));
    if (!token) {
      response.status(401).json({ error: 'capability_ticket_required' });
      return;
    }

    let claims: CapabilityTicketClaims;
    try {
      claims = verifyCapabilityTicket(token, options);
    } catch (error) {
      const code = error instanceof CapabilityTicketError ? error.code : 'invalid_claims';
      response.status(401).json({ error: 'invalid_capability_ticket', code });
      return;
    }

    try {
      const decision = await options.authorize(claims);
      if (!decision.allowed) {
        response.status(403).json({ error: 'capability_denied', reason: decision.reason });
        return;
      }
      (request as CapabilityTicketRequest).capabilityTicket = claims;
      next();
    } catch {
      response.status(503).json({ error: 'capability_authority_unavailable' });
    }
  };
}
