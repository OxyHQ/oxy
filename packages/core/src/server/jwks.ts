/**
 * Cached resolver for an Oxy-published Ed25519 JWKS.
 *
 * An Oxy-signed short-lived token a service verifies offline — an app
 * assertion (ADR 0045) — names its signing key by `kid`; this fetches and
 * caches the published set that key comes from.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const JWKS_REFRESH_FLOOR_MS = 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 20;

function parseJwks(value: unknown): Map<string, KeyObject> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('JWKS is malformed');
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > JWKS_MAX_KEYS)
    throw new Error('JWKS has an invalid key set');
  const result = new Map<string, KeyObject>();
  for (const entry of keys) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error('JWKS key is malformed');
    const key = entry as Record<string, unknown>;
    if (
      key.kty !== 'OKP' ||
      key.crv !== 'Ed25519' ||
      key.alg !== 'EdDSA' ||
      key.use !== 'sig' ||
      typeof key.x !== 'string' ||
      typeof key.kid !== 'string' ||
      !KEY_ID_PATTERN.test(key.kid) ||
      Object.prototype.hasOwnProperty.call(key, 'd') ||
      result.has(key.kid)
    )
      throw new Error('JWKS key is unsupported');
    const x = Buffer.from(key.x, 'base64url');
    if (x.length !== 32 || x.toString('base64url') !== key.x)
      throw new Error('JWKS key is not Ed25519');
    result.set(
      key.kid,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }),
    );
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
      } catch {
        // Fall through: a still-valid cached key is served, anything else is unknown.
      }
    }
    return expiresAt > clock() ? keys.get(keyId) : undefined;
  };
}
