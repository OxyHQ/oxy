/**
 * App assertions (ADR 0045): which Oxy app a request comes from.
 *
 * Every official app shares one device session (ADR 0029), and an app's
 * `clientId` is public, so nothing a request carries on its own says which app
 * sent it. An app proves itself to Oxy instead — the browser's `Origin`, a Play
 * Integrity verdict, or an App Attest assertion — and Oxy signs a five-minute
 * `OXY-APP+JWT` naming the application, the person (`sub`) and the session
 * (`sid`). The app sends it as `X-Oxy-App-Assertion`; a service that needs the
 * app verifies it here and reads the application from nothing else.
 *
 * Signing and verification live together so Oxy (the signer) and every
 * verifier share one implementation of the format.
 */

import { sign as signBytes, verify as verifyBytes, type KeyObject } from 'node:crypto';
import {
  APP_ASSERTION_PLATFORMS,
  OXY_APP_ASSERTION_AUDIENCE,
  OXY_APP_ASSERTION_HEADER,
  OXY_APP_ASSERTION_TTL_SECONDS,
  OXY_APP_ASSERTION_TYPE,
  type AppAssertionPlatform,
} from '@oxy.so/contracts';
import { z } from '@oxy.so/zod3';
import { createOxyJwksKeyResolver } from './jwks';

export const OXY_APP_ASSERTION_DEFAULT_ISSUER = 'https://api.oxy.so';
/** The lowercase spelling Node gives `req.headers`. */
const HEADER = OXY_APP_ASSERTION_HEADER.toLowerCase();

const ALGORITHM = 'EdDSA';
const CLOCK_SKEW_SECONDS = 5;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ASSERTION_BYTES = 4096;

const identifier = z.string().min(1).max(255);

export const oxyAppAssertionClaimsSchema = z
  .object({
    iss: z.string().min(1).max(256),
    aud: z.literal(OXY_APP_ASSERTION_AUDIENCE),
    /** The person the assertion was issued to. */
    sub: identifier,
    /** The session it was issued to. */
    sid: identifier,
    /** The application that proved itself. */
    app: identifier,
    /** How it proved itself. */
    platform: z.enum(APP_ASSERTION_PLATFORMS),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().uuid(),
  })
  .strict();

export type OxyAppAssertionClaims = z.infer<typeof oxyAppAssertionClaimsSchema>;

export type OxyAppAssertionErrorCode =
  | 'malformed'
  | 'unknown_key'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'wrong_issuer'
  | 'not_yet_valid'
  | 'expired'
  | 'ttl_exceeded';

export class OxyAppAssertionError extends Error {
  constructor(public readonly code: OxyAppAssertionErrorCode) {
    super(`App assertion rejected: ${code}`);
    this.name = 'OxyAppAssertionError';
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeObject(segment: string): Record<string, unknown> {
  if (!BASE64URL_PATTERN.test(segment)) throw new OxyAppAssertionError('malformed');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new OxyAppAssertionError('malformed');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new OxyAppAssertionError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OxyAppAssertionError('malformed');
  }
  return value as Record<string, unknown>;
}

/** Signs an app assertion. Oxy is the only intended caller. */
export function signOxyAppAssertion(
  claims: OxyAppAssertionClaims,
  signing: { readonly keyId: string; readonly privateKey: KeyObject },
): string {
  const parsed = oxyAppAssertionClaimsSchema.parse(claims);
  if (parsed.exp <= parsed.iat || parsed.exp - parsed.iat > OXY_APP_ASSERTION_TTL_SECONDS) {
    throw new OxyAppAssertionError('ttl_exceeded');
  }
  if (!KEY_ID_PATTERN.test(signing.keyId)) throw new OxyAppAssertionError('malformed');
  if (signing.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new OxyAppAssertionError('unknown_key');
  }
  const header = { alg: ALGORITHM, typ: OXY_APP_ASSERTION_TYPE, kid: signing.keyId };
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(parsed))}`;
  return `${input}.${base64Url(signBytes(null, Buffer.from(input), signing.privateKey))}`;
}

/** Reads the `kid`, refusing anything that is not an `OXY-APP+JWT` header. Trusts nothing else. */
export function readOxyAppAssertionKeyId(token: string): string {
  if (token.length > MAX_ASSERTION_BYTES) throw new OxyAppAssertionError('malformed');
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new OxyAppAssertionError('malformed');
  }
  const header = decodeObject(segments[0] as string);
  if (
    Object.keys(header).length !== 3 ||
    header.alg !== ALGORITHM ||
    header.typ !== OXY_APP_ASSERTION_TYPE ||
    typeof header.kid !== 'string' ||
    !KEY_ID_PATTERN.test(header.kid)
  ) {
    throw new OxyAppAssertionError('malformed');
  }
  return header.kid;
}

export interface OxyAppAssertionVerificationOptions {
  readonly publicKey: KeyObject | undefined;
  readonly issuer: string;
  readonly now?: Date;
}

/**
 * Stateless verification: header, signature, claim shape, issuer, audience and
 * lifetime. The session binding is the caller's to check —
 * {@link verifyAppAssertion} does both.
 */
export function verifyOxyAppAssertion(
  token: string,
  options: OxyAppAssertionVerificationOptions,
): OxyAppAssertionClaims {
  readOxyAppAssertionKeyId(token);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [
    string,
    string,
    string,
  ];
  const publicKey = options.publicKey;
  if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new OxyAppAssertionError('unknown_key');
  }
  if (!BASE64URL_PATTERN.test(encodedSignature)) throw new OxyAppAssertionError('malformed');
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== encodedSignature) {
    throw new OxyAppAssertionError('malformed');
  }
  if (!verifyBytes(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, signature)) {
    throw new OxyAppAssertionError('invalid_signature');
  }

  const parsed = oxyAppAssertionClaimsSchema.safeParse(decodeObject(encodedPayload));
  if (!parsed.success) throw new OxyAppAssertionError('invalid_claims');
  const claims = parsed.data;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== options.issuer) throw new OxyAppAssertionError('wrong_issuer');
  if (claims.iat > now + CLOCK_SKEW_SECONDS) throw new OxyAppAssertionError('not_yet_valid');
  if (claims.exp <= now) throw new OxyAppAssertionError('expired');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > OXY_APP_ASSERTION_TTL_SECONDS) {
    throw new OxyAppAssertionError('ttl_exceeded');
  }
  return claims;
}

/** The verified session a request authenticated with: `req.userId` and `req.sessionId`. */
export interface OxyAppAssertionSession {
  readonly userId: string;
  readonly sessionId: string;
}

export interface VerifyAppAssertionOptions {
  /** The request's VERIFIED session. The assertion must name exactly this person and session. */
  readonly session: OxyAppAssertionSession | null | undefined;
  /** Oxy's API origin, which signs the assertion. Defaults to `https://api.oxy.so`. */
  readonly issuer?: string;
  /** Defaults to `/capabilities/.well-known/jwks.json` on the issuer. */
  readonly jwksUrl?: string;
  /** Replaces the JWKS fetch, e.g. in tests. */
  readonly resolvePublicKey?: (keyId: string) => Promise<KeyObject | undefined>;
  readonly now?: Date;
}

export interface VerifiedAppAssertion {
  readonly applicationId: string;
  readonly platform: AppAssertionPlatform;
}

/** One cached JWKS resolver per URL, shared by every call in the process. */
const resolvers = new Map<string, (keyId: string) => Promise<KeyObject | undefined>>();

function resolverFor(jwksUrl: string): (keyId: string) => Promise<KeyObject | undefined> {
  let resolver = resolvers.get(jwksUrl);
  if (!resolver) {
    resolver = createOxyJwksKeyResolver({ jwksUrl });
    resolvers.set(jwksUrl, resolver);
  }
  return resolver;
}

/**
 * Which application this request comes from, or `null`.
 *
 * Verifies the `OXY-APP+JWT` against Oxy's JWKS (fetched and cached), checks
 * `typ`, `iss`, `aud`, `exp`, and that `sub` and `sid` are the request's own
 * verified person and session. Anything else — no session, a malformed or
 * forged token, another person's or another session's assertion, an expired
 * one, a JWKS that cannot be read — reads as no app, never as an error a
 * caller could mistake for one.
 */
export async function verifyAppAssertion(
  token: string | null | undefined,
  options: VerifyAppAssertionOptions,
): Promise<VerifiedAppAssertion | null> {
  const session = options.session;
  if (!token || !session?.userId || !session.sessionId) return null;
  const issuer = options.issuer ?? OXY_APP_ASSERTION_DEFAULT_ISSUER;
  try {
    const keyId = readOxyAppAssertionKeyId(token);
    const resolve =
      options.resolvePublicKey ??
      resolverFor(
        options.jwksUrl ?? new URL('/capabilities/.well-known/jwks.json', issuer).toString(),
      );
    const claims = verifyOxyAppAssertion(token, {
      publicKey: await resolve(keyId),
      issuer,
      ...(options.now ? { now: options.now } : {}),
    });
    if (claims.sub !== session.userId || claims.sid !== session.sessionId) return null;
    return { applicationId: claims.app, platform: claims.platform };
  } catch {
    return null;
  }
}

/**
 * The `X-Oxy-App-Assertion` a request carries, or `null` when it carries none
 * or carries it more than once.
 */
export function readAppAssertionHeader(req: {
  readonly headers: Record<string, string | string[] | undefined>;
}): string | null {
  const value = req.headers[HEADER];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ASSERTION_BYTES
    ? value
    : null;
}
