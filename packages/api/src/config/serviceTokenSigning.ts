import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { logger } from '../utils/logger';

export const SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE = 'SERVICE_TOKEN_SIGNING_KEY_ID';
export const SERVICE_TOKEN_PRIVATE_KEY_VARIABLE = 'SERVICE_TOKEN_PRIVATE_KEY';
export const SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE = 'SERVICE_TOKEN_PUBLIC_JWKS';

export interface ServiceTokenPublicJwk extends JsonWebKey {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly use: 'sig';
  readonly alg: 'EdDSA';
  readonly kid: string;
}

export interface ServiceTokenSigningConfig {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicJwks: readonly ServiceTokenPublicJwk[];
}

let cached: {
  readonly keyId: string;
  readonly privateKeySource: string;
  readonly publicJwksSource: string;
  readonly production: boolean;
  readonly config: ServiceTokenSigningConfig;
} | undefined;

function parsePublicJwks(source: string): ServiceTokenPublicJwk[] {
  if (source.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE} must be a JSON Web Key Set`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE} must be a JSON Web Key Set`);
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE}.keys must be an array`);
  }
  const seen = new Set<string>();
  return keys.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE}.keys[${index}] must be an object`);
    }
    const key = value as Record<string, unknown>;
    if (
      key.kty !== 'OKP'
      || key.crv !== 'Ed25519'
      || typeof key.x !== 'string'
      || key.x.length === 0
      || key.use !== 'sig'
      || key.alg !== 'EdDSA'
      || typeof key.kid !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/.test(key.kid)
      || Object.prototype.hasOwnProperty.call(key, 'd')
      || seen.has(key.kid as string)
    ) {
      throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE}.keys[${index}] is not a public Ed25519 signing key`);
    }
    const x = Buffer.from(key.x, 'base64url');
    if (x.length !== 32 || x.toString('base64url') !== key.x) {
      throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE}.keys[${index}] is not a valid Ed25519 public key`);
    }
    try {
      const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    } catch {
      throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE}.keys[${index}] is not a valid Ed25519 public key`);
    }
    seen.add(key.kid);
    return {
      kty: 'OKP',
      crv: 'Ed25519',
      x: key.x,
      use: 'sig',
      alg: 'EdDSA',
      kid: key.kid,
    };
  });
}

/**
 * The key a process with NO configured signing key mints with, outside
 * production only. Generated once per process and never written anywhere, so a
 * development or test token is unverifiable by any other process — dev and
 * production key material cannot meet. Production refuses to boot instead: the
 * HS256 fallback this replaced is retired (ADR 0012), and there is no third
 * option.
 */
let ephemeral: { readonly keyId: string; readonly privateKey: KeyObject } | undefined;

function ephemeralSigningKey(): { readonly keyId: string; readonly privateKey: KeyObject } {
  if (!ephemeral) {
    ephemeral = {
      keyId: `dev-ephemeral-${randomBytes(6).toString('hex')}`,
      privateKey: generateKeyPairSync('ed25519').privateKey,
    };
    logger.warn('[ServiceToken] no signing key configured; minting with a per-process ephemeral Ed25519 key', {
      kid: ephemeral.keyId,
    });
  }
  return ephemeral;
}

function readPrivateKey(source: string): KeyObject {
  const pem = source.includes('-----BEGIN')
    ? source
    : Buffer.from(source, 'base64').toString('utf8');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error(`${SERVICE_TOKEN_PRIVATE_KEY_VARIABLE} must contain a PKCS#8 Ed25519 private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${SERVICE_TOKEN_PRIVATE_KEY_VARIABLE} must contain a PKCS#8 Ed25519 private key`);
  }
  return privateKey;
}

/**
 * Active mint key plus the public-only rotation set. All-or-nothing: a partial
 * signing configuration is a deployment error, never a reason to guess a key.
 * Production without a signing key throws — the boot check in `server.ts` turns
 * that into a refusal to start rather than a service that cannot mint.
 */
export function serviceTokenSigningConfig(): ServiceTokenSigningConfig {
  const configuredKeyId = process.env[SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE] ?? '';
  const privateKeySource = process.env[SERVICE_TOKEN_PRIVATE_KEY_VARIABLE] ?? '';
  const publicJwksSource = process.env[SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE] ?? '';
  const production = process.env.NODE_ENV === 'production';
  if (
    cached?.keyId === configuredKeyId
    && cached.privateKeySource === privateKeySource
    && cached.publicJwksSource === publicJwksSource
    && cached.production === production
  ) return cached.config;

  let keyId: string;
  let privateKey: KeyObject;
  if (configuredKeyId.length === 0 && privateKeySource.length === 0) {
    if (production) {
      throw new Error(
        `${SERVICE_TOKEN_PRIVATE_KEY_VARIABLE} and ${SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE} are required in production: service tokens are EdDSA only (ADR 0012)`,
      );
    }
    ({ keyId, privateKey } = ephemeralSigningKey());
  } else {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(configuredKeyId)) {
      throw new Error(`${SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE} must be 1-128 URL-safe characters`);
    }
    if (privateKeySource.length === 0) {
      throw new Error(`${SERVICE_TOKEN_PRIVATE_KEY_VARIABLE} must be configured with ${SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE}`);
    }
    keyId = configuredKeyId;
    privateKey = readPrivateKey(privateKeySource);
  }

  const exported = createPublicKey(privateKey).export({ format: 'jwk' });
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || typeof exported.x !== 'string') {
    throw new Error(`${SERVICE_TOKEN_PRIVATE_KEY_VARIABLE} did not produce an Ed25519 public key`);
  }
  const active: ServiceTokenPublicJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: exported.x,
    use: 'sig',
    alg: 'EdDSA',
    kid: keyId,
  };
  const byId = new Map<string, ServiceTokenPublicJwk>([[keyId, active]]);
  for (const key of parsePublicJwks(publicJwksSource)) {
    const existing = byId.get(key.kid);
    if (existing) {
      throw new Error(`${SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE} duplicates active kid ${key.kid}`);
    }
    byId.set(key.kid, key);
  }
  const config = { keyId, privateKey, publicJwks: [...byId.values()] } satisfies ServiceTokenSigningConfig;
  cached = { keyId: configuredKeyId, privateKeySource, publicJwksSource, production, config };
  return config;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function signServiceTokenEd25519(payload: Record<string, unknown>): string {
  const config = serviceTokenSigningConfig();
  const header = { alg: 'EdDSA', typ: 'JWT', kid: config.keyId } as const;
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  return `${signingInput}.${base64Url(signBytes(null, Buffer.from(signingInput), config.privateKey))}`;
}

export function serviceTokenPublicJwks(): readonly ServiceTokenPublicJwk[] {
  return serviceTokenSigningConfig().publicJwks;
}
