/**
 * Google Play Integrity configuration (ADR 0045).
 *
 * Oxy decodes an Android app's integrity token server-side with Google
 * (`decodeIntegrityToken`), as a Google Cloud service account of the project
 * the apps are linked to in the Play Console. Both values are operator inputs;
 * without them Android assertions are refused (`integrity_unconfigured`, 503)
 * rather than issued unverified.
 *
 * - `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` (plain config): the Google Cloud
 *   project NUMBER (not its id). The app requests tokens for it, so the
 *   challenge answer hands it to the device.
 * - `PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY` (SSM SecureString): that project's
 *   service-account key, the JSON Google issues, raw or base64. The account
 *   needs no IAM role; the Play Integrity API must be enabled on the project.
 */

import { createPrivateKey, type KeyObject } from 'node:crypto';

export const PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE = 'PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER';
export const PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE = 'PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY';

export interface PlayIntegrityConfig {
  readonly cloudProjectNumber: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly privateKey: KeyObject;
  readonly tokenUri: string;
}

let cached: { readonly source: string; readonly config: PlayIntegrityConfig | null } | undefined;

function readServiceAccount(source: string): Omit<PlayIntegrityConfig, 'cloudProjectNumber'> {
  const json = source.startsWith('{') ? source : Buffer.from(source, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE} must be a service-account key`);
  }
  const key = parsed as Record<string, unknown>;
  if (
    key.type !== 'service_account' ||
    typeof key.client_email !== 'string' ||
    typeof key.private_key !== 'string' ||
    typeof key.private_key_id !== 'string'
  ) {
    throw new Error(`${PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE} must be a service-account key`);
  }
  const tokenUri =
    typeof key.token_uri === 'string' ? key.token_uri : 'https://oauth2.googleapis.com/token';
  if (new URL(tokenUri).protocol !== 'https:') {
    throw new Error(`${PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE} token_uri must be https`);
  }
  return {
    clientEmail: key.client_email,
    privateKeyId: key.private_key_id,
    privateKey: createPrivateKey(key.private_key),
    tokenUri,
  };
}

/**
 * The Play Integrity configuration, or `null` when it is not configured. A
 * half-configured or unreadable value throws: it is a deployment error, never a
 * reason to accept a token unverified.
 */
export function playIntegrityConfig(): PlayIntegrityConfig | null {
  const projectNumber = process.env[PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE]?.trim() ?? '';
  const serviceAccount = process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE]?.trim() ?? '';
  const source = `${projectNumber}\n${serviceAccount}`;
  if (cached?.source === source) return cached.config;
  let config: PlayIntegrityConfig | null = null;
  if (projectNumber || serviceAccount) {
    if (!/^[0-9]{1,20}$/.test(projectNumber)) {
      throw new Error(`${PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE} must be a project number`);
    }
    if (!serviceAccount) {
      throw new Error(
        `${PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE} must be configured with ${PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE}`,
      );
    }
    config = { cloudProjectNumber: projectNumber, ...readServiceAccount(serviceAccount) };
  }
  cached = { source, config };
  return config;
}
