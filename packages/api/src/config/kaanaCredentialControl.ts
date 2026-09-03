import { createPrivateKey, type KeyObject } from 'node:crypto';
import { logger } from '../utils/logger';

export const KAANA_CREDENTIAL_CONTROL_KEY_ID_VARIABLE = 'KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID';
export const KAANA_CREDENTIAL_CONTROL_PRIVATE_KEY_VARIABLE =
  'KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY';

export interface KaanaCredentialControlConfig {
  readonly baseUrl: 'https://kaana.ai';
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export type KaanaCredentialControlResolution =
  | {
      readonly status: 'configured';
      readonly config: KaanaCredentialControlConfig;
    }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly variable: string };

const FORBIDDEN_KEY_ID_CHARACTERS = /[:,\r\n\s]/;

/** Dedicated signing authority for customer-credential mutations. */
export function resolveKaanaCredentialControl(): KaanaCredentialControlResolution {
  const baseUrl = process.env.KAANA_BASE_URL?.trim() ?? '';
  const keyId = process.env[KAANA_CREDENTIAL_CONTROL_KEY_ID_VARIABLE]?.trim() ?? '';
  const rawPrivateKey = process.env[KAANA_CREDENTIAL_CONTROL_PRIVATE_KEY_VARIABLE]?.trim() ?? '';

  if (keyId.length === 0 && rawPrivateKey.length === 0) return { status: 'absent' };
  if (baseUrl !== 'https://kaana.ai') return unreadable('KAANA_BASE_URL');
  if (keyId.length === 0 || keyId.length > 128 || FORBIDDEN_KEY_ID_CHARACTERS.test(keyId)) {
    return unreadable(KAANA_CREDENTIAL_CONTROL_KEY_ID_VARIABLE);
  }

  const privateKey = parseEd25519PrivateKey(rawPrivateKey);
  if (privateKey === undefined) {
    return unreadable(KAANA_CREDENTIAL_CONTROL_PRIVATE_KEY_VARIABLE);
  }
  return {
    status: 'configured',
    config: { baseUrl: 'https://kaana.ai', keyId, privateKey },
  };
}

function unreadable(variable: string): KaanaCredentialControlResolution {
  logger.error(
    'inference.kaana.credential_control_config_unreadable',
    new Error(`${variable} is not usable; BYOK mutations are disabled`),
    { component: 'kaana-credential-control', variable },
  );
  return { status: 'unreadable', variable };
}

function parseEd25519PrivateKey(raw: string): KeyObject | undefined {
  if (raw.length === 0) return undefined;
  let pem = raw;
  if (!raw.includes('-----BEGIN')) {
    try {
      pem = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}
