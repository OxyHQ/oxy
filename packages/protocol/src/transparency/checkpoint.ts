/**
 * Transparency checkpoint — the signed, hash-linked commitment to a tree root.
 *
 * A checkpoint is what the operator PUBLISHES: "at `periodEnd` I committed to
 * `root` over `treeSize` subjects, and the previous checkpoint hashed to
 * `prevCheckpointHash`". The `prevCheckpointHash` link makes the checkpoint
 * sequence itself append-only: once any checkpoint is anchored publicly, none of
 * its ancestors can be rewritten without breaking the chain of hashes.
 *
 * ## Why the signature covers ONLY the five fields
 *
 * The signing input is derived from exactly `{index, periodEnd, treeSize, root,
 * prevCheckpointHash}` — never from the surrounding storage document, and never
 * from other signatures. That is what makes a checkpoint CO-SIGNABLE: the
 * operator and any number of independent witnesses (e.g. user-run
 * `@oxyhq/node` deployments) each sign the identical bytes with their own key,
 * with zero coordination and in any order. Two conflicting roots for one
 * `index`, each carrying valid signatures, is then transferable proof of
 * equivocation that needs no cooperation from the operator to demonstrate.
 *
 * Extra fields on the object passed in are ignored by design, so handing this a
 * database document cannot change what was signed.
 */

import { canonicalize } from '../envelope/canonicalJson';
import { sha256 } from '../envelope/recordId';
import { signMessage, verifySignature } from '../envelope/sign';
import { deriveSecp256k1PublicKey } from '../secp256k1';

/** Domain prefix for checkpoint signing bytes. */
const CHECKPOINT_PREFIX = 'oxy.transparency.checkpoint.v1:';

/** The one signature algorithm the protocol emits. */
const ALG = 'ES256K-DER-SHA256' as const;

/** The signed body of a checkpoint. */
export interface TransparencyCheckpointFields {
  /** Monotonic checkpoint number; gapless. */
  index: number;
  /** End of the period this checkpoint commits to (ms epoch). */
  periodEnd: number;
  /** Number of leaves (subjects) committed. */
  treeSize: number;
  /** The Merkle root over the committed heads. */
  root: string;
  /** {@link checkpointHash} of the previous checkpoint; `null` at the first one. */
  prevCheckpointHash: string | null;
}

/** One signer's endorsement of a checkpoint — the operator's or a witness's. */
export interface TransparencyCheckpointSignature {
  /** Uncompressed hex public key of the signer. */
  publicKey: string;
  alg: typeof ALG;
  /** DER-encoded hex secp256k1 signature over {@link checkpointSigningInput}. */
  signature: string;
}

/**
 * The exact bytes every co-signer signs: the canonical JSON of the five signed
 * fields under the checkpoint domain prefix. Key order in the input object is
 * irrelevant; extra properties are dropped.
 */
export function checkpointSigningInput(fields: TransparencyCheckpointFields): string {
  return `${CHECKPOINT_PREFIX}${canonicalize({
    index: fields.index,
    periodEnd: fields.periodEnd,
    treeSize: fields.treeSize,
    root: fields.root,
    prevCheckpointHash: fields.prevCheckpointHash,
  })}`;
}

/**
 * The content address of a checkpoint — what the NEXT checkpoint's
 * `prevCheckpointHash` references.
 */
export async function checkpointHash(fields: TransparencyCheckpointFields): Promise<string> {
  return sha256(checkpointSigningInput(fields));
}

/**
 * Sign a checkpoint with an explicit private key. Used by the operator and,
 * identically, by every witness that co-signs the same checkpoint.
 */
export async function signCheckpoint(
  fields: TransparencyCheckpointFields,
  privateKeyHex: string,
): Promise<TransparencyCheckpointSignature> {
  return {
    publicKey: deriveSecp256k1PublicKey(privateKeyHex),
    alg: ALG,
    signature: await signMessage(checkpointSigningInput(fields), privateKeyHex),
  };
}

/**
 * Verify one signature over a checkpoint's signed fields.
 *
 * Confirms the signature matches the embedded `publicKey` for exactly these
 * fields. It does NOT establish that the key belongs to a trusted operator or an
 * accepted witness — that policy lives with the verifier's key list.
 */
export async function verifyCheckpointSignature(
  fields: TransparencyCheckpointFields,
  signature: TransparencyCheckpointSignature,
): Promise<boolean> {
  return verifySignature(checkpointSigningInput(fields), signature.signature, signature.publicKey);
}
