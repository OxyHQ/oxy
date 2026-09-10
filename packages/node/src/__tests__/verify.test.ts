/**
 * Node record-verification tests — the cross-package verification proof.
 *
 * Envelopes are SIGNED with the shared crypto (`KeyManager` from `@oxy.so/core`
 * + `@oxy.so/protocol`'s `signMessage`, the same primitives the Commons vault
 * uses) and VERIFIED with `@oxy.so/protocol/node`'s `verifyNodeRecordEnvelope`
 * (which reuses `verifyEnvelopeSignature` / `computeRecordId` from
 * `@oxy.so/protocol`). A record signed elsewhere therefore verifies on the node
 * with no node-local crypto — this is the verifier the node app drives.
 */

import { computeRecordId, signedRecordSigningInput } from '@oxy.so/protocol';
import { verifyNodeRecordEnvelope } from '@oxy.so/protocol/node';
import { buildSignedEnvelope, generateTestKeyPair } from './helpers/signEnvelope';

describe('verifyNodeRecordEnvelope', () => {
  it('verifies a real owner-signed envelope and returns the matching recordId', async () => {
    const owner = generateTestKeyPair();
    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 0,
      prev: null,
      record: { displayName: 'Ada' },
    });

    const result = await verifyNodeRecordEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The recordId is the SHA-256 of the canonical signing input — recomputed
      // independently here to prove the node derives the same content address.
      expect(result.recordId).toBe(await computeRecordId(envelope));
      expect(result.envelope.publicKey).toBe(owner.publicKey);
    }
  });

  it('rejects a structurally invalid envelope', async () => {
    const result = await verifyNodeRecordEnvelope({ not: 'an envelope' });
    expect(result).toEqual({ ok: false, reason: 'invalid_envelope' });
  });

  it('rejects a v1 envelope (the node is a v2 hash chain)', async () => {
    const owner = generateTestKeyPair();
    const v1 = {
      version: 1 as const,
      type: 'identity' as const,
      subject: 'did:web:api.oxy.so:u:test-owner',
      issuer: 'did:web:api.oxy.so:u:test-owner',
      record: { hello: 'world' },
      issuedAt: Date.now(),
      publicKey: owner.publicKey,
      alg: 'ES256K-DER-SHA256' as const,
      signature: 'deadbeef',
    };
    const result = await verifyNodeRecordEnvelope(v1);
    expect(result).toEqual({ ok: false, reason: 'not_v2' });
  });

  it('rejects an envelope whose signature does not match the public key', async () => {
    const owner = generateTestKeyPair();
    const attacker = generateTestKeyPair();
    const envelope = await buildSignedEnvelope({
      privateKey: attacker.privateKey, // signed by the attacker...
      publicKey: owner.publicKey, // ...but claims the owner's key
      seq: 0,
      prev: null,
    });

    const result = await verifyNodeRecordEnvelope(envelope);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered record body (signature no longer covers the bytes)', async () => {
    const owner = generateTestKeyPair();
    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 0,
      prev: null,
      record: { amount: 1 },
    });

    const tampered = { ...envelope, record: { amount: 1_000_000 } };
    // Sanity: the signing input genuinely changed.
    expect(signedRecordSigningInput(tampered)).not.toBe(signedRecordSigningInput(envelope));

    const result = await verifyNodeRecordEnvelope(tampered);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
