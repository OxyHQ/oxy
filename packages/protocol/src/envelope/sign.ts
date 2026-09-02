/**
 * Signing & verification — explicit-key crypto for signed-record envelopes.
 *
 * Stateless: every function takes the key material explicitly (no KeyManager,
 * no secure storage). `@oxyhq/core` binds these to a device key; nodes and the
 * API verify with them. The scheme is `ES256K-DER-SHA256` everywhere:
 * secp256k1 over the SHA-256 of the canonical bytes, DER-encoded.
 */

import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { signedRecordSigningInput, type SignedRecordSigningFields } from './signingInput';
import { sha256 } from './recordId';
import {
  deriveSecp256k1PublicKey,
  signSecp256k1Digest,
  verifySecp256k1Digest,
} from '../secp256k1';

/** The one signature algorithm identifier the protocol emits. */
const ALG = 'ES256K-DER-SHA256' as const;

/**
 * Sign an arbitrary message with an explicit private key.
 *
 * Hashes the message with SHA-256, then signs the digest with secp256k1,
 * returning the DER-encoded hex signature. The low-level primitive behind both
 * {@link signEnvelope} and `@oxyhq/core`'s device-key signing helpers.
 */
export async function signMessage(message: string, privateKeyHex: string): Promise<string> {
  const digest = await sha256(message);
  return signSecp256k1Digest(privateKeyHex, digest);
}

/**
 * Verify a DER-encoded signature over a message against a public key.
 *
 * Returns `false` on any error (invalid signature, malformed key/signature,
 * etc.) rather than throwing, so callers can treat verification as a boolean.
 */
export async function verifySignature(
  message: string,
  signature: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const digest = await sha256(message);
    return verifySecp256k1Digest(publicKeyHex, digest, signature);
  } catch {
    // Malformed key / signature / input is not a valid signature.
    return false;
  }
}

/**
 * Build a fully-signed {@link SignedRecordEnvelope} from its signing fields and
 * an explicit private key.
 *
 * Computes the canonical {@link signedRecordSigningInput}, signs it
 * (`ES256K-DER-SHA256`), and attaches the DERIVED `publicKey` (uncompressed
 * hex — identical to `KeyManager`'s stored key for the same private key) plus
 * the `alg`/`signature`. The signature covers every field EXCEPT
 * `publicKey`/`signature`.
 */
export async function signEnvelope(
  fields: SignedRecordSigningFields,
  privateKeyHex: string,
): Promise<SignedRecordEnvelope> {
  const signingInput = signedRecordSigningInput(fields);
  const signature = await signMessage(signingInput, privateKeyHex);
  const publicKey = deriveSecp256k1PublicKey(privateKeyHex);
  return { ...fields, publicKey, alg: ALG, signature };
}

/**
 * Verify a signed-record envelope: recompute the canonical signing input from
 * the envelope's own fields and check the signature against the envelope's
 * `publicKey`.
 *
 * This confirms the signature is internally consistent with the embedded
 * `publicKey`. It does NOT establish that `publicKey` is an authorized
 * verification method for `subject` — that authorization check belongs to the
 * server / node owner check.
 */
export async function verifyEnvelopeSignature(envelope: SignedRecordEnvelope): Promise<boolean> {
  return verifySignature(signedRecordSigningInput(envelope), envelope.signature, envelope.publicKey);
}
