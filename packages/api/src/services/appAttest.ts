/**
 * Apple App Attest verification (ADR 0045), as Apple specifies it in
 * "Validating apps that connect to your server".
 *
 * Pure: no database, no clock but the one passed in. `appAssertion.service.ts`
 * decides what to verify, burns the challenge first, and stores what this
 * returns.
 *
 * ## The attestation (once per key)
 *
 * 1. The certificate chain `x5c` (credential certificate, intermediate) chains
 *    to Apple's App Attestation Root CA, each certificate inside its validity.
 * 2. `nonce = SHA256(authData || clientDataHash)` equals the octet string in the
 *    credential certificate's extension `1.2.840.113635.100.8.2`.
 * 3. `SHA256` of the credential key (uncompressed P-256 point) is the key id.
 * 4. `authData.rpIdHash` is `SHA256(<teamId>.<bundleId>)`.
 * 5. The counter is 0.
 * 6. The AAGUID names an allowed environment (`appattest` + seven zero bytes is
 *    production, `appattestdevelop` development).
 * 7. The credential id is the key id.
 *
 * ## An assertion (every request)
 *
 * 1. `nonce = SHA256(authenticatorData || clientDataHash)`, and the signature is
 *    an ECDSA P-256 / SHA-256 signature over it with the attested key.
 * 2. `rpIdHash` is `SHA256(<teamId>.<bundleId>)`.
 * 3. The counter is strictly greater than the stored one (the caller stores it
 *    with a conditional update, so two racing assertions cannot both pass).
 *
 * The client data is the challenge's `requestHash` as UTF-8, which is what
 * `@expo/app-integrity` hashes into `clientDataHash` on the device.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  X509Certificate,
} from 'node:crypto';
import { decodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import { APP_ATTEST_ENVIRONMENTS, type AppAttestEnvironment } from '../db/schema/appAttestKeys';

/** The credential certificate extension that carries the attestation nonce. */
export const APP_ATTEST_NONCE_EXTENSION_OID = '1.2.840.113635.100.8.2';

export { APP_ATTEST_ENVIRONMENTS, type AppAttestEnvironment };

const AAGUIDS: Record<AppAttestEnvironment, Buffer> = {
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]),
  development: Buffer.from('appattestdevelop', 'ascii'),
};

export type AppAttestFailure =
  | 'malformed'
  | 'certificate_chain'
  | 'nonce_mismatch'
  | 'key_id_mismatch'
  | 'rp_id_mismatch'
  | 'counter'
  | 'environment'
  | 'signature';

export class AppAttestVerificationError extends Error {
  constructor(public readonly reason: AppAttestFailure) {
    super(`App Attest verification failed: ${reason}`);
    this.name = 'AppAttestVerificationError';
  }
}

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** `clientDataHash` for a challenge: SHA-256 of its `requestHash`, as the device computes it. */
export function appAttestClientDataHash(requestHash: string): Buffer {
  return sha256(Buffer.from(requestHash, 'utf8'));
}

/** The App Attest app id: `<teamId>.<bundleId>`. */
export function appAttestAppId(teamId: string, bundleId: string): string {
  return `${teamId}.${bundleId}`;
}

function decodeMap(bytes: Buffer): Map<string | number, CBORType> {
  let value: CBORType;
  try {
    value = decodeCBOR(new Uint8Array(bytes));
  } catch {
    throw new AppAttestVerificationError('malformed');
  }
  if (!(value instanceof Map)) throw new AppAttestVerificationError('malformed');
  return value;
}

function bytesAt(map: Map<string | number, CBORType>, key: string): Buffer {
  const value = map.get(key);
  if (!(value instanceof Uint8Array)) throw new AppAttestVerificationError('malformed');
  return Buffer.from(value);
}

interface AuthenticatorData {
  readonly rpIdHash: Buffer;
  readonly signCount: number;
  readonly aaguid: Buffer | null;
  readonly credentialId: Buffer | null;
}

/** WebAuthn authenticator data: rpIdHash(32) flags(1) signCount(4) [aaguid(16) idLength(2) id …]. */
function parseAuthenticatorData(data: Buffer, attested: boolean): AuthenticatorData {
  if (data.length < 37) throw new AppAttestVerificationError('malformed');
  const rpIdHash = data.subarray(0, 32);
  const signCount = data.readUInt32BE(33);
  if (!attested) return { rpIdHash, signCount, aaguid: null, credentialId: null };
  if (data.length < 55) throw new AppAttestVerificationError('malformed');
  const aaguid = data.subarray(37, 53);
  const idLength = data.readUInt16BE(53);
  if (data.length < 55 + idLength) throw new AppAttestVerificationError('malformed');
  return { rpIdHash, signCount, aaguid, credentialId: data.subarray(55, 55 + idLength) };
}

function validAt(certificate: X509Certificate, now: Date): boolean {
  return (
    new Date(certificate.validFrom).getTime() <= now.getTime() &&
    now.getTime() <= new Date(certificate.validTo).getTime()
  );
}

function issuedBy(child: X509Certificate, issuer: X509Certificate, now: Date): boolean {
  return child.checkIssued(issuer) && child.verify(issuer.publicKey) && validAt(child, now);
}

/** The nonce in the credential certificate: `SEQUENCE { [1] EXPLICIT OCTET STRING }`. */
function attestationNonce(credentialCertificate: X509Certificate): Buffer {
  let extensionValue: ArrayBuffer | undefined;
  try {
    const certificate = AsnConvert.parse(credentialCertificate.raw, Certificate);
    extensionValue = certificate.tbsCertificate.extensions?.find(
      (extension) => extension.extnID === APP_ATTEST_NONCE_EXTENSION_OID,
    )?.extnValue.buffer;
  } catch {
    throw new AppAttestVerificationError('malformed');
  }
  if (!extensionValue) throw new AppAttestVerificationError('nonce_mismatch');
  const parsed = asn1js.fromBER(extensionValue);
  const sequence = parsed.offset === -1 ? null : parsed.result;
  if (!(sequence instanceof asn1js.Sequence)) throw new AppAttestVerificationError('malformed');
  const tagged = sequence.valueBlock.value[0];
  if (
    !(tagged instanceof asn1js.Constructed) ||
    tagged.idBlock.tagClass !== 3 ||
    tagged.idBlock.tagNumber !== 1
  ) {
    throw new AppAttestVerificationError('malformed');
  }
  const octets = tagged.valueBlock.value[0];
  if (!(octets instanceof asn1js.OctetString)) throw new AppAttestVerificationError('malformed');
  return Buffer.from(octets.valueBlock.valueHexView);
}

/** The uncompressed P-256 point (`04 || x || y`) of an EC public key. */
function uncompressedPoint(certificate: X509Certificate): Buffer {
  const jwk = certificate.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new AppAttestVerificationError('malformed');
  }
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

export interface AppAttestAttestationInput {
  /** The attestation object, as the device returned it (base64-decoded). */
  readonly attestation: Buffer;
  readonly clientDataHash: Buffer;
  /** The key id the device names (standard base64). */
  readonly keyId: string;
  /** `<teamId>.<bundleId>`. */
  readonly appId: string;
  /** Apple's App Attestation Root CA (a test root in tests). */
  readonly rootCertificate: X509Certificate;
  readonly allowedEnvironments: readonly AppAttestEnvironment[];
  readonly now: Date;
}

export interface AttestedAppAttestKey {
  /** SubjectPublicKeyInfo DER of the attested key. */
  readonly publicKeySpki: Buffer;
  readonly environment: AppAttestEnvironment;
  readonly signCount: number;
}

/** Verifies an App Attest attestation; throws {@link AppAttestVerificationError}. */
export function verifyAppAttestAttestation(input: AppAttestAttestationInput): AttestedAppAttestKey {
  const object = decodeMap(input.attestation);
  if (object.get('fmt') !== 'apple-appattest') throw new AppAttestVerificationError('malformed');
  const statement = object.get('attStmt');
  if (!(statement instanceof Map)) throw new AppAttestVerificationError('malformed');
  const chain = statement.get('x5c');
  if (!Array.isArray(chain) || chain.length < 2 || !chain.every((c) => c instanceof Uint8Array)) {
    throw new AppAttestVerificationError('malformed');
  }
  const authData = bytesAt(object, 'authData');

  let credential: X509Certificate;
  let intermediate: X509Certificate;
  try {
    credential = new X509Certificate(Buffer.from(chain[0] as Uint8Array));
    intermediate = new X509Certificate(Buffer.from(chain[1] as Uint8Array));
  } catch {
    throw new AppAttestVerificationError('malformed');
  }
  // 1. The chain ends at Apple's root.
  if (
    !validAt(input.rootCertificate, input.now) ||
    !issuedBy(intermediate, input.rootCertificate, input.now) ||
    !issuedBy(credential, intermediate, input.now)
  ) {
    throw new AppAttestVerificationError('certificate_chain');
  }
  // 2. The nonce binds this authenticator data to this challenge.
  if (!attestationNonce(credential).equals(sha256(authData, input.clientDataHash))) {
    throw new AppAttestVerificationError('nonce_mismatch');
  }
  // 3. The key is the one the device names.
  const keyIdHash = sha256(uncompressedPoint(credential));
  if (keyIdHash.toString('base64') !== input.keyId) {
    throw new AppAttestVerificationError('key_id_mismatch');
  }
  const data = parseAuthenticatorData(authData, true);
  // 4. For this app.
  if (!data.rpIdHash.equals(sha256(Buffer.from(input.appId, 'utf8')))) {
    throw new AppAttestVerificationError('rp_id_mismatch');
  }
  // 5. Never used.
  if (data.signCount !== 0) throw new AppAttestVerificationError('counter');
  // 6. In an allowed environment.
  const environment = APP_ATTEST_ENVIRONMENTS.find((name) => data.aaguid?.equals(AAGUIDS[name]));
  if (!environment || !input.allowedEnvironments.includes(environment)) {
    throw new AppAttestVerificationError('environment');
  }
  // 7. The credential is the key.
  if (!data.credentialId?.equals(keyIdHash))
    throw new AppAttestVerificationError('key_id_mismatch');

  return {
    publicKeySpki: credential.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    environment,
    signCount: 0,
  };
}

export interface AppAttestAssertionInput {
  /** The assertion object, as the device returned it (base64-decoded). */
  readonly assertion: Buffer;
  readonly clientDataHash: Buffer;
  readonly publicKeySpki: Buffer;
  readonly appId: string;
  readonly previousSignCount: number;
}

/** Verifies an App Attest assertion; returns its counter. Throws {@link AppAttestVerificationError}. */
export function verifyAppAttestAssertion(input: AppAttestAssertionInput): { signCount: number } {
  const object = decodeMap(input.assertion);
  const signature = bytesAt(object, 'signature');
  const authenticatorData = bytesAt(object, 'authenticatorData');
  const nonce = sha256(authenticatorData, input.clientDataHash);
  let valid: boolean;
  try {
    valid = verifySignature(
      'sha256',
      nonce,
      createPublicKey({ key: input.publicKeySpki, format: 'der', type: 'spki' }),
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new AppAttestVerificationError('signature');
  const data = parseAuthenticatorData(authenticatorData, false);
  if (!data.rpIdHash.equals(sha256(Buffer.from(input.appId, 'utf8')))) {
    throw new AppAttestVerificationError('rp_id_mismatch');
  }
  if (data.signCount <= input.previousSignCount) throw new AppAttestVerificationError('counter');
  return { signCount: data.signCount };
}
