/**
 * Code-signing for Oxy Updates manifests and directives.
 *
 * Code signing is MANDATORY for the update protocol: the manifest transitively
 * signs every asset (each asset's SHA-256 hash is inside the signed manifest and
 * verified by the client), so a signed manifest is the only thing standing
 * between a compromised ALB/CDN and remote code execution on every device.
 *
 * This server never produces an unsigned manifest or directive. Every signable
 * part carries `expo-signature`, whether or not the client sent
 * `expo-expect-signature` (a binary built without the certificate ignores the
 * header; one built with it rejects anything unsigned). Without a usable key the
 * manifest route answers 503 and the publish API refuses to record an update,
 * because an update that can only be served unsigned must not exist.
 *
 * Scheme: RSASSA-PKCS1-v1_5 over SHA-256 (`rsa-v1_5-sha256`), keyid `main`,
 * matching Expo's reference server and the `@expo/code-signing-certificates`
 * certificate the client embeds. The signature is computed over the EXACT bytes
 * of the part body (the manifest/directive JSON), and the header value is an
 * Expo Structured-Field-Value dictionary: `sig="<base64>", keyid="main"`.
 *
 * The private key is provided as base64-encoded PEM via
 * `UPDATES_CODE_SIGNING_PRIVATE_KEY` (SSM `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`,
 * bound in `deploy-aws.yml`). The process boots without it so the rest of the
 * API keeps serving, but every update request then fails with
 * {@link CodeSigningNotConfiguredError} (503). Its public half is
 * `@oxy.so/app-preset`'s `certs/oxy-updates-code-signing.pem`.
 */

import crypto from 'crypto';
import { ServiceUnavailableError } from '../../utils/error';
import { logger } from '../../utils/logger';

/** keyid advertised in the `expo-signature` header; the client selects the cert by it. */
export const CODE_SIGNING_KEY_ID = 'main';

/** Algorithm token advertised for the signature (`expo-expect-signature` alg). */
export const CODE_SIGNING_ALG = 'rsa-v1_5-sha256';

/**
 * Thrown when `UPDATES_CODE_SIGNING_PRIVATE_KEY` is unset or unusable. A 503: the
 * request is fine, the capability is not configured, and nothing changes until an
 * operator sets the key. The manifest route answers it instead of serving an
 * unsigned manifest; the publish API answers it instead of recording an update.
 */
export class CodeSigningNotConfiguredError extends ServiceUnavailableError {
  constructor(message = 'UPDATES_CODE_SIGNING_PRIVATE_KEY is not configured') {
    super(message);
    this.name = 'CodeSigningNotConfiguredError';
  }
}

/**
 * Cached decoded PEM. `undefined` = not yet resolved this process; `null` =
 * resolved and absent/unusable. Cached across calls so we neither re-decode nor
 * re-log on every hot manifest request.
 */
let cachedPrivateKeyPem: string | null | undefined;

/** Decode + cache the PEM from env. Returns `null` when unset or unusable. */
function resolvePrivateKeyPem(): string | null {
  if (cachedPrivateKeyPem !== undefined) {
    return cachedPrivateKeyPem;
  }

  const raw = process.env.UPDATES_CODE_SIGNING_PRIVATE_KEY;
  if (!raw || raw.trim().length === 0) {
    cachedPrivateKeyPem = null;
    return null;
  }

  let pem: string;
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) {
    // Allow a raw PEM (dev convenience); production supplies base64 PEM.
    pem = trimmed;
  } else {
    pem = Buffer.from(trimmed, 'base64').toString('utf8');
  }

  if (!pem.includes('-----BEGIN')) {
    logger.error(
      'UPDATES_CODE_SIGNING_PRIVATE_KEY did not decode to a PEM private key; code signing disabled',
    );
    cachedPrivateKeyPem = null;
    return null;
  }

  cachedPrivateKeyPem = pem;
  return pem;
}

/** Reset the cached key. Test-only — lets a test set the env then re-resolve. */
export function resetSigningKeyCache(): void {
  cachedPrivateKeyPem = undefined;
}

/** True when a code-signing private key PEM is configured (not proof it signs; see below). */
export function isCodeSigningConfigured(): boolean {
  return resolvePrivateKeyPem() !== null;
}

/**
 * Throw {@link CodeSigningNotConfiguredError} unless the configured key can
 * actually produce a signature. The publish API calls it before recording an
 * update, so a key that decodes to a PEM but cannot sign (truncated, wrong type)
 * is caught at publish time rather than on the first device's manifest request.
 */
export function assertCodeSigningConfigured(): void {
  signPartBytes(Buffer.from('oxy-updates-signing-probe', 'utf8'));
}

/**
 * Sign the exact bytes of a manifest/directive part and return the
 * `expo-signature` header value: `sig="<base64>", keyid="main"`.
 *
 * @throws {CodeSigningNotConfiguredError} when no usable private key is configured.
 */
export function signPartBytes(bytes: Buffer): string {
  const pem = resolvePrivateKeyPem();
  if (pem === null) {
    throw new CodeSigningNotConfiguredError();
  }

  let signatureBase64: string;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(bytes);
    signer.end();
    signatureBase64 = signer.sign(pem, 'base64');
  } catch (error) {
    logger.error('Update manifest signing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new CodeSigningNotConfiguredError('Configured code-signing key is unusable');
  }

  // Expo SFV dictionary. base64 uses only [A-Za-z0-9+/=], none of which require
  // SFV string-escaping, so `sig="<base64>", keyid="main"` is the exact output
  // the structured-headers serializer produces for these string items.
  return `sig="${signatureBase64}", keyid="${CODE_SIGNING_KEY_ID}"`;
}
