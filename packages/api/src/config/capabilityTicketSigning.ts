import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export const CAPABILITY_TICKET_SIGNING_KEY_ID_VARIABLE = 'CAPABILITY_TICKET_SIGNING_KEY_ID';
export const CAPABILITY_TICKET_SIGNING_PRIVATE_KEY_VARIABLE = 'CAPABILITY_TICKET_SIGNING_PRIVATE_KEY';

export interface CapabilityTicketSigningConfig {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicJwk: {
    readonly kty: 'OKP';
    readonly crv: 'Ed25519';
    readonly x: string;
    readonly use: 'sig';
    readonly alg: 'EdDSA';
    readonly kid: string;
  };
}

let cached: {
  readonly keyId: string;
  readonly privateKeySource: string;
  readonly config: CapabilityTicketSigningConfig;
} | undefined;

export function capabilityTicketSigningConfig(): CapabilityTicketSigningConfig {
  const keyId = process.env[CAPABILITY_TICKET_SIGNING_KEY_ID_VARIABLE]?.trim() ?? '';
  const privateKeySource = process.env[CAPABILITY_TICKET_SIGNING_PRIVATE_KEY_VARIABLE]?.trim() ?? '';
  if (cached?.keyId === keyId && cached.privateKeySource === privateKeySource) return cached.config;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) {
    throw new Error(`${CAPABILITY_TICKET_SIGNING_KEY_ID_VARIABLE} must be 1-128 URL-safe characters`);
  }
  const pem = privateKeySource.includes('-----BEGIN')
    ? privateKeySource
    : Buffer.from(privateKeySource, 'base64').toString('utf8');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error(`${CAPABILITY_TICKET_SIGNING_PRIVATE_KEY_VARIABLE} must contain an Ed25519 private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${CAPABILITY_TICKET_SIGNING_PRIVATE_KEY_VARIABLE} must contain an Ed25519 private key`);
  }
  const publicKey = createPublicKey(privateKey);
  const exported = publicKey.export({ format: 'jwk' });
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || typeof exported.x !== 'string') {
    throw new Error('Capability ticket signing key did not export as an Ed25519 JWK');
  }
  const config: CapabilityTicketSigningConfig = {
    keyId,
    privateKey,
    publicKey,
    publicJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: exported.x,
      use: 'sig',
      alg: 'EdDSA',
      kid: keyId,
    },
  };
  cached = { keyId, privateKeySource, config };
  return config;
}
