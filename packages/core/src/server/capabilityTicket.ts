import { randomUUID, sign as signBytes, verify as verifyBytes, type KeyObject } from 'node:crypto';
import {
  capabilityTicketClaimsSchema,
  type CapabilityTicketClaims,
  type PolicyDecision,
} from '@oxy.so/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const ALGORITHM = 'EdDSA';
const TOKEN_TYPE = 'OXY-CAPABILITY+JWT';
const DEFAULT_MAX_TTL_SECONDS = 300;

type UnsignedCapabilityTicketClaims = Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'>;

export interface CapabilityTicketSigningOptions {
  privateKey: KeyObject;
  keyId: string;
  issuer: string;
  ttlSeconds?: number;
  now?: Date;
  jti?: string;
}

export interface CapabilityTicketVerificationOptions {
  resolvePublicKey: (keyId: string) => KeyObject | undefined;
  audience: string;
  issuer?: string;
  now?: Date;
  maximumTtlSeconds?: number;
}

/**
 * A signing-key lookup that may be asynchronous — `createOxyJwksKeyResolver`
 * is — for the verifiers that already run asynchronously (the middleware and
 * `createLiveCapabilityTicketVerifier`). The ticket's own `kid` is passed; no
 * caller needs to decode the header first.
 */
export type CapabilityTicketKeyResolver = (
  keyId: string,
) => KeyObject | undefined | Promise<KeyObject | undefined>;

/** {@link CapabilityTicketVerificationOptions} with a key lookup that may be asynchronous. */
export interface AsyncCapabilityTicketVerificationOptions
  extends Omit<CapabilityTicketVerificationOptions, 'resolvePublicKey'> {
  resolvePublicKey: CapabilityTicketKeyResolver;
}

export interface CapabilityTicketRequest extends Request {
  capabilityTicket?: CapabilityTicketClaims;
}

export interface CapabilityTicketMiddlewareOptions
  extends AsyncCapabilityTicketVerificationOptions {
  authorize: (claims: CapabilityTicketClaims) => Promise<PolicyDecision>;
}

export class CapabilityTicketError extends Error {
  constructor(
    public readonly code:
      | 'malformed'
      | 'invalid_signature'
      | 'unknown_key'
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

export function issueCapabilityTicket(
  claims: UnsignedCapabilityTicketClaims,
  options: CapabilityTicketSigningOptions,
): string {
  const ttlSeconds = options.ttlSeconds ?? 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > DEFAULT_MAX_TTL_SECONDS) {
    throw new CapabilityTicketError(
      'ttl_exceeded',
      `Capability ticket TTL must be between 1 and ${DEFAULT_MAX_TTL_SECONDS} seconds`,
    );
  }

  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const payload = capabilityTicketClaimsSchema.parse({
    ...claims,
    iss: options.issuer,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: options.jti ?? randomUUID(),
  });
  if (options.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new CapabilityTicketError(
      'invalid_claims',
      'Capability tickets require an Ed25519 private key',
    );
  }
  const header = { alg: ALGORITHM, typ: TOKEN_TYPE, kid: options.keyId } as const;
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  return `${signingInput}.${base64UrlEncode(signBytes(null, Buffer.from(signingInput), options.privateKey))}`;
}

/** A ticket split and its header checked, before any key is looked up. */
interface ParsedCapabilityTicket {
  readonly keyId: string;
  readonly signingInput: string;
  readonly encodedPayload: string;
  readonly encodedSignature: string;
}

function parseCapabilityTicket(token: string): ParsedCapabilityTicket {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new CapabilityTicketError('malformed', 'Capability ticket must have three segments');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new CapabilityTicketError('malformed', 'Capability ticket contains an empty segment');
  }

  const header = decodeJsonSegment(encodedHeader);
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new CapabilityTicketError('malformed', 'Capability ticket header is not supported');
  }
  const headerRecord = header as Record<string, unknown>;
  if (
    Object.keys(headerRecord).length !== 3 ||
    headerRecord.alg !== ALGORITHM ||
    headerRecord.typ !== TOKEN_TYPE ||
    typeof headerRecord.kid !== 'string' ||
    headerRecord.kid.length === 0
  ) {
    throw new CapabilityTicketError('malformed', 'Capability ticket header is not supported');
  }
  return {
    keyId: headerRecord.kid,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    encodedPayload,
    encodedSignature,
  };
}

/** Signature and claims of a parsed ticket against the key its `kid` resolved to. */
function checkCapabilityTicket(
  ticket: ParsedCapabilityTicket,
  publicKey: KeyObject | undefined,
  options: Omit<CapabilityTicketVerificationOptions, 'resolvePublicKey'>,
): CapabilityTicketClaims {
  if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new CapabilityTicketError('unknown_key', 'Capability ticket signing key is not trusted');
  }
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(ticket.encodedSignature, 'base64url');
  } catch {
    throw new CapabilityTicketError('malformed', 'Capability ticket signature is malformed');
  }
  if (!verifyBytes(null, Buffer.from(ticket.signingInput), publicKey, providedSignature)) {
    throw new CapabilityTicketError('invalid_signature', 'Capability ticket signature is invalid');
  }

  const parsed = capabilityTicketClaimsSchema.safeParse(decodeJsonSegment(ticket.encodedPayload));
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
    throw new CapabilityTicketError(
      'ttl_exceeded',
      'Capability ticket lifetime exceeds the accepted maximum',
    );
  }
  if (claims.aud !== options.audience) {
    throw new CapabilityTicketError(
      'wrong_audience',
      'Capability ticket audience does not match this app',
    );
  }
  if (options.issuer && claims.iss !== options.issuer) {
    throw new CapabilityTicketError('wrong_issuer', 'Capability ticket issuer is not trusted');
  }

  return claims;
}

export function verifyCapabilityTicket(
  token: string,
  options: CapabilityTicketVerificationOptions,
): CapabilityTicketClaims {
  const ticket = parseCapabilityTicket(token);
  return checkCapabilityTicket(ticket, options.resolvePublicKey(ticket.keyId), options);
}

/**
 * A verifier for one ticket whose key lookup may be asynchronous: the key is
 * resolved once, and the returned `check` re-verifies signature and claims
 * against it (the live verifier checks again after introspection, so a slow
 * authority answer cannot outlive the ticket).
 *
 * @internal Shared by the middleware and `createLiveCapabilityTicketVerifier`.
 */
export async function resolveCapabilityTicketKey(
  token: string,
  options: AsyncCapabilityTicketVerificationOptions,
): Promise<{ check: () => CapabilityTicketClaims }> {
  const ticket = parseCapabilityTicket(token);
  let publicKey: KeyObject | undefined;
  try {
    publicKey = await options.resolvePublicKey(ticket.keyId);
  } catch {
    // A key set that cannot be read trusts no key; never a different error class.
    publicKey = undefined;
  }
  return { check: () => checkCapabilityTicket(ticket, publicKey, options) };
}

export function readCapabilityAuthorization(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token, extra] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'capability' || !token || extra) return null;
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
      claims = (await resolveCapabilityTicketKey(token, options)).check();
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

export { inputSatisfiesCapabilityLimits } from '@oxy.so/contracts';
