/**
 * Test helper: forge REAL signed-record envelopes using the shared crypto —
 * `KeyManager.generateKeyPairSync` (`@oxy.so/core`) for a storage-free secp256k1
 * keypair and `@oxy.so/protocol`'s `signMessage` over `signedRecordSigningInput`.
 *
 * This is the crux of the cross-package verification proof: the tests SIGN with
 * the same `@oxy.so/protocol` primitives that the production Commons vault uses,
 * and the node VERIFIES with those same primitives (`@oxy.so/protocol/node`'s
 * `verifyNodeRecordEnvelope`). A record forged here must verify on the node with
 * no node-local crypto.
 *
 * Not a test file (no `.test.ts` suffix) — imported by the suites.
 */

import { KeyManager } from '@oxy.so/core';
import { signedRecordSigningInput, signMessage, computeRecordId } from '@oxy.so/protocol';
import type { SignedRecordEnvelope } from '@oxy.so/contracts';

export interface TestKeyPair {
  privateKey: string;
  publicKey: string;
}

/** Generate a fresh secp256k1 keypair (hex) with no secure-storage side effects. */
export function generateTestKeyPair(): TestKeyPair {
  return KeyManager.generateKeyPairSync();
}

const DEFAULT_SUBJECT = 'did:web:api.oxy.so:u:test-owner';

export interface BuildEnvelopeOptions {
  privateKey: string;
  publicKey: string;
  seq: number;
  prev: string | null;
  subject?: string;
  issuer?: string;
  type?: SignedRecordEnvelope['type'];
  collection?: string;
  rkey?: string;
  record?: Record<string, unknown>;
  issuedAt?: number;
}

/** Build a fully-signed v2 envelope; verifies against `verifyNodeRecordEnvelope`. */
export async function buildSignedEnvelope(options: BuildEnvelopeOptions): Promise<SignedRecordEnvelope> {
  const subject = options.subject ?? DEFAULT_SUBJECT;
  const fields = {
    version: 2 as const,
    type: options.type ?? ('identity' as const),
    subject,
    issuer: options.issuer ?? subject,
    record: options.record ?? { hello: 'world' },
    issuedAt: options.issuedAt ?? Date.now(),
    seq: options.seq,
    prev: options.prev,
    collection: options.collection ?? 'app.oxy.identity',
    rkey: options.rkey ?? 'self',
  };
  const signingInput = signedRecordSigningInput(fields);
  const signature = await signMessage(signingInput, options.privateKey);
  return { ...fields, publicKey: options.publicKey, alg: 'ES256K-DER-SHA256', signature };
}

/** The content address (`recordId`) of an envelope — re-exported for chaining `prev`. */
export async function recordIdOf(envelope: SignedRecordEnvelope): Promise<string> {
  return computeRecordId(envelope);
}
