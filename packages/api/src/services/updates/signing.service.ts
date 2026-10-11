/**
 * Code-signing for Oxy Updates manifests and directives.
 *
 * Code signing is MANDATORY for the update protocol: the manifest transitively
 * signs every asset (each asset's SHA-256 hash is inside the signed manifest and
 * verified by the client), so a signed manifest is the only thing standing
 * between a compromised ALB/CDN and remote code execution on every device. The
 * client sends `expo-expect-signature`; we MUST return a valid `expo-signature`
 * for each signable part or refuse to serve.
 *
 * Scheme: RSASSA-PKCS1-v1_5 over SHA-256 (`rsa-v1_5-sha256`), keyid `main`,
 * matching Expo's reference server and the `@expo/code-signing-certificates`
 * certificate the client embeds. The signature is computed over the EXACT bytes
 * of the part body (the manifest/directive JSON), and the header value is an
 * Expo Structured-Field-Value dictionary: `sig="<base64>", keyid="main"`.
 *
 * The private key is provided as base64-encoded PEM via
 * `UPDATES_CODE_SIGNING_PRIVATE_KEY`. It is OPTIONAL at boot (the process starts
 * without it); a request that needs a signature when the key is absent fails
 * with a clear {@link CodeSigningNotConfiguredError} that the route maps to 500.
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger';

/** keyid advertised in the `expo-signature` header; the client selects the cert by it. */
export const CODE_SIGNING_KEY_ID = 'main';

/** Algorithm token advertised for the signature (`expo-expect-signature` alg). */
export const CODE_SIGNING_ALG = 'rsa-v1_5-sha256';

/**
 * Thrown when a signature is required but `UPDATES_CODE_SIGNING_PRIVATE_KEY` is
 * unset (or unusable). The manifest route maps this to an HTTP 500 with a clear
 * log rather than serving an unsigned manifest a code-signing client would
 * reject anyway.
 */
export class CodeSigningNotConfiguredError extends Error {
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

/** True when a usable code-signing private key is configured. */
export function isCodeSigningConfigured(): boolean {
  return resolvePrivateKeyPem() !== null;
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
