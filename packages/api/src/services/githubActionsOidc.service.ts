/**
 * Verifies a GitHub Actions OIDC token (ADR 0057).
 *
 * A job with `permissions: id-token: write` can ask GitHub for a JWT that
 * states which repository, ref, workflow and event it is running for. GitHub
 * signs it with RS256 under a key it publishes at
 * `https://token.actions.githubusercontent.com/.well-known/jwks`. This module
 * checks that signature and the standard claims and returns the GitHub claims
 * the trusted-publisher match reads. It decides nothing about Oxy authority:
 * `services/githubTrustedPublishing.service.ts` does.
 *
 * Verified with `node:crypto` directly rather than through a JWT library, for
 * the same reason `middleware/serviceToken.ts` does: one algorithm, an exact
 * header, canonical base64url, and no option that could widen any of it.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';

/** The only issuer accepted. Compared exactly. */
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

export const GITHUB_ACTIONS_JWKS_URL = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;

/** Clock skew tolerated on `exp`, `nbf` and `iat`. */
export const GITHUB_ACTIONS_CLOCK_SKEW_SECONDS = 60;

/**
 * Longest `exp - iat` accepted. GitHub issues tokens that live minutes; an hour
 * is a ceiling against a token that was never meant to be short, not a guess at
 * GitHub's number.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60;

const JWKS_CACHE_MS = 10 * 60 * 1000;
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 128 * 1024;
const JWKS_MAX_KEYS = 20;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** RSA moduli below 2048 bits are refused whatever GitHub publishes. */
const MIN_RSA_MODULUS_BYTES = 256;

/** The GitHub claims a trusted publisher is matched on, plus the run for the log. */
export interface GithubActionsClaims {
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositoryOwner: string;
  readonly ref: string;
  readonly eventName: string;
  readonly workflowRef: string;
  readonly sha: string;
  readonly runId: string;
}

/** Why a token was refused: a closed vocabulary, safe to return to the caller. */
export type GithubActionsTokenFailure =
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'missing_claims';

export class GithubActionsTokenError extends Error {
  readonly reason: GithubActionsTokenFailure;
  constructor(reason: GithubActionsTokenFailure, message: string) {
    super(message);
    this.name = 'GithubActionsTokenError';
    this.reason = reason;
  }
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid base64url');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('non-canonical base64url');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJwks(value: unknown): Map<string, KeyObject> {
  if (!isRecord(value)) throw new Error('JWKS is malformed');
  const keys = value.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > JWKS_MAX_KEYS)
    throw new Error('JWKS has an invalid key set');
  const result = new Map<string, KeyObject>();
  for (const entry of keys) {
    if (!isRecord(entry)) throw new Error('JWKS key is malformed');
    // GitHub publishes RSA signing keys. Anything else in the set is not a key
    // this verifier would ever use, so it is skipped rather than failing the set.
    if (entry.kty !== 'RSA' || (entry.use !== undefined && entry.use !== 'sig')) continue;
    if (entry.alg !== undefined && entry.alg !== 'RS256') continue;
    if (
      typeof entry.kid !== 'string' ||
      !KEY_ID_PATTERN.test(entry.kid) ||
      typeof entry.n !== 'string' ||
      typeof entry.e !== 'string' ||
      Object.hasOwn(entry, 'd') ||
      result.has(entry.kid)
    )
      throw new Error('JWKS key is unsupported');
    if (Buffer.from(entry.n, 'base64url').length < MIN_RSA_MODULUS_BYTES)
      throw new Error('JWKS key is too short');
    result.set(
      entry.kid,
      createPublicKey({ key: { kty: 'RSA', n: entry.n, e: entry.e }, format: 'jwk' }),
    );
  }
  if (result.size === 0) throw new Error('JWKS has no RS256 signing key');
  return result;
}

export interface GithubActionsJwksResolverOptions {
  readonly jwksUrl?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
}

/**
 * Cached GitHub JWKS. An unknown `kid` refreshes at most once a minute, which is
 * how a key GitHub rotated in is picked up without letting a flood of forged key
 * ids become a flood of fetches. A failed refresh keeps serving keys still inside
 * their cache window, so a GitHub blip does not stop a publish that GitHub
 * itself already signed.
 */
export function createGithubActionsJwksResolver(
  options: GithubActionsJwksResolverOptions = {},
): (keyId: string) => Promise<KeyObject | undefined> {
  const jwksUrl = options.jwksUrl ?? GITHUB_ACTIONS_JWKS_URL;
  // Traced (Bun's fetch is invisible to the undici instrumentation), and read
  // per call, so the process-wide resolver uses the runtime's current fetch.
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => tracedFetch(input, init));
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
        const response = await fetchImpl(jwksUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`JWKS returned HTTP ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > JWKS_MAX_BYTES)
          throw new Error('JWKS exceeds the size limit');
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
      } catch (error: unknown) {
        // A still-valid cached key is served below; anything else is unknown.
        logger.warn('[GithubActionsOidc] JWKS refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return expiresAt > clock() ? keys.get(keyId) : undefined;
  };
}

const defaultResolver = createGithubActionsJwksResolver();

function stringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new GithubActionsTokenError('missing_claims', `The token has no ${name} claim`);
  return value;
}

function integerClaim(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new GithubActionsTokenError('missing_claims', `The token has no ${name} claim`);
  return value;
}

export interface VerifyGithubActionsTokenOptions {
  /** The exact `aud` the token must carry: this API's own origin. */
  readonly audience: string;
  readonly resolveKey?: (keyId: string) => Promise<KeyObject | undefined>;
  /** Epoch seconds. */
  readonly now?: number;
}

/** Verify signature, issuer, audience and lifetime; return the claims a publisher matches on. */
export async function verifyGithubActionsToken(
  token: string,
  options: VerifyGithubActionsTokenOptions,
): Promise<GithubActionsClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0))
    throw new GithubActionsTokenError('malformed', 'The token is not a JWT');
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = decodeSegment(headerSegment);
    payload = decodeSegment(payloadSegment);
  } catch {
    throw new GithubActionsTokenError('malformed', 'The token is not a JWT');
  }
  if (!isRecord(header) || !isRecord(payload))
    throw new GithubActionsTokenError('malformed', 'The token is not a JWT');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !KEY_ID_PATTERN.test(header.kid))
    throw new GithubActionsTokenError('malformed', 'The token is not an RS256 JWT with a key id');

  const key = await (options.resolveKey ?? defaultResolver)(header.kid);
  if (!key)
    throw new GithubActionsTokenError('unknown_key', 'The token was not signed by a GitHub key');
  const signature = Buffer.from(signatureSegment, 'base64url');
  if (
    signature.toString('base64url') !== signatureSegment ||
    !verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      key,
      signature,
    )
  )
    throw new GithubActionsTokenError('bad_signature', 'The token signature is invalid');

  // Signature first, claims second: nothing below is believed until GitHub's
  // key has vouched for it.
  if (payload.iss !== GITHUB_ACTIONS_ISSUER)
    throw new GithubActionsTokenError('wrong_issuer', 'The token was not issued by GitHub Actions');
  if (typeof payload.aud !== 'string' || payload.aud !== options.audience)
    throw new GithubActionsTokenError(
      'wrong_audience',
      `The token audience must be exactly ${options.audience}`,
    );

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const exp = integerClaim(payload, 'exp');
  const iat = integerClaim(payload, 'iat');
  if (exp + GITHUB_ACTIONS_CLOCK_SKEW_SECONDS <= now)
    throw new GithubActionsTokenError('expired', 'The token has expired');
  if (
    iat - GITHUB_ACTIONS_CLOCK_SKEW_SECONDS > now ||
    exp <= iat ||
    exp - iat > MAX_TOKEN_LIFETIME_SECONDS
  )
    throw new GithubActionsTokenError('not_yet_valid', 'The token lifetime is not acceptable');
  if (payload.nbf !== undefined) {
    const nbf = integerClaim(payload, 'nbf');
    if (nbf - GITHUB_ACTIONS_CLOCK_SKEW_SECONDS > now)
      throw new GithubActionsTokenError('not_yet_valid', 'The token is not valid yet');
  }

  return {
    repository: stringClaim(payload, 'repository'),
    repositoryId: stringClaim(payload, 'repository_id'),
    repositoryOwner: stringClaim(payload, 'repository_owner'),
    ref: stringClaim(payload, 'ref'),
    eventName: stringClaim(payload, 'event_name'),
    workflowRef: stringClaim(payload, 'workflow_ref'),
    sha: stringClaim(payload, 'sha'),
    runId: stringClaim(payload, 'run_id'),
  };
}
