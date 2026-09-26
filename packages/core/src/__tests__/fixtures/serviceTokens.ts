/**
 * Shared fixtures for service-token tests (ADR 0012).
 *
 * Service tokens verify only as Ed25519 (`alg: 'EdDSA'`) against Oxy's
 * published JWKS. These helpers mint real Ed25519 tokens with a `kid`, build
 * the JWKS document a verifier fetches, and mock `fetch` so every request for
 * it gets a fresh `Response` (a body can be read only once).
 *
 * Not a test file: jest's `testMatch` only collects `*.test.ts`.
 */

import { createHmac, generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

export const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

export interface ServiceTokenSigningKey {
  kid: string;
  privateKey: KeyObject;
  /** The public JWK exactly as `/.well-known/jwks.json` publishes it. */
  jwk: Record<string, unknown>;
}

export function createSigningKey(kid: string): ServiceTokenSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid },
  };
}

/** Sign `payload` as a compact EdDSA JWT with the header Oxy's issuer emits. */
export function signEdDSA(payload: Record<string, unknown>, key: ServiceTokenSigningKey): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: key.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(signBytes(null, Buffer.from(signingInput), key.privateKey))}`;
}

/** Sign `payload` as an HS256 JWT — the retired service-token format. */
export function signHS256(payload: Record<string, unknown>, secret: string): string {
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
}

/** An unsigned JWT: `alg: 'none'` and an empty signature segment. */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
}

export function jwksBody(...keys: ServiceTokenSigningKey[]): string {
  return JSON.stringify({ keys: keys.map((key) => key.jwk) });
}

/**
 * Serve a JWKS from `fetch`. `source` is re-read on every call, so a test can
 * rotate the published set (or make it fail) between requests.
 */
export function mockJwksFetch(
  source: () => ServiceTokenSigningKey[] | { status: number; body?: string } = () => [],
): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const current = source();
    if (Array.isArray(current)) {
      return new Response(jwksBody(...current), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(current.body ?? '', { status: current.status });
  });
}
