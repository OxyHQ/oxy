/**
 * Signed-record envelope tests — the DEVICE-key-bound path in `@oxyhq/core`.
 *
 * `SignatureService.signRecord` / `signRecordV2` read the device key from
 * `KeyManager` and delegate the cryptography to `@oxyhq/protocol`'s
 * `signEnvelope`. These tests prove the orchestration: an envelope built from a
 * stored key round-trips through the protocol's `verifyEnvelopeSignature`, and
 * tampering breaks it. The pure canonical-bytes / `computeRecordId` guards live
 * in `@oxyhq/protocol`'s own suite.
 *
 * We mock `KeyManager.getPrivateKey` with a real secp256k1 private key,
 * so the signing/verification is genuine cryptography (not a stub).
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  canonicalize,
  signedRecordSigningInput,
  verifySignature,
  verifyEnvelopeSignature,
} from '@oxyhq/protocol';
import { KeyManager } from '../keyManager';
import { SignatureService } from '../signatureService';

describe('SignatureService.signRecord / verifyEnvelopeSignature', () => {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const privateKey = keyPair.privateKey.padStart(64, '0');

  beforeEach(() => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(privateKey);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a well-formed self-issued envelope', async () => {
    const subject = 'did:web:oxy.so:u:abc123';
    const record = { displayName: 'Nate', bio: 'builder' };

    const envelope = await SignatureService.signRecord('profile', subject, record);

    expect(envelope.version).toBe(1);
    expect(envelope.type).toBe('profile');
    expect(envelope.subject).toBe(subject);
    expect(envelope.issuer).toBe(subject); // self-issued
    expect(envelope.record).toEqual(record);
    expect(envelope.publicKey).toBe(publicKey); // derived from the stored private key
    expect(envelope.alg).toBe('ES256K-DER-SHA256');
    expect(typeof envelope.signature).toBe('string');
    expect(envelope.signature.length).toBeGreaterThan(0);
    expect(typeof envelope.issuedAt).toBe('number');
  });

  it('round-trips: a freshly signed record verifies', async () => {
    const envelope = await SignatureService.signRecord('identity', 'did:web:oxy.so:u:u1', {
      handle: '@nate',
      nested: { a: 1, b: [2, 3] },
    });
    await expect(verifyEnvelopeSignature(envelope)).resolves.toBe(true);
  });

  it('signs the canonical JSON of every field except publicKey + signature', async () => {
    const subject = 'did:web:oxy.so:u:u2';
    const record = { z: 1, a: 2 };
    const envelope = await SignatureService.signRecord('profile', subject, record);

    const expectedInput = canonicalize({
      version: envelope.version,
      type: envelope.type,
      subject: envelope.subject,
      issuer: envelope.issuer,
      record: envelope.record,
      issuedAt: envelope.issuedAt,
    });

    // The helper reproduces exactly that input from the envelope.
    expect(signedRecordSigningInput(envelope)).toBe(expectedInput);
    // And it omits publicKey/signature.
    expect(expectedInput).not.toContain(envelope.publicKey);
    expect(expectedInput).not.toContain(envelope.signature);

    // The signature verifies against that exact input + the embedded key.
    await expect(
      verifySignature(expectedInput, envelope.signature, envelope.publicKey),
    ).resolves.toBe(true);
  });

  describe('tamper detection', () => {
    let envelope: SignedRecordEnvelope;

    beforeEach(async () => {
      envelope = await SignatureService.signRecord('profile', 'did:web:oxy.so:u:u3', {
        displayName: 'Original',
        score: 10,
      });
    });

    it('rejects a mutated record', async () => {
      const tampered: SignedRecordEnvelope = {
        ...envelope,
        record: { ...envelope.record, displayName: 'Tampered' },
      };
      await expect(verifyEnvelopeSignature(tampered)).resolves.toBe(false);
    });

    it('rejects a changed subject', async () => {
      const tampered: SignedRecordEnvelope = { ...envelope, subject: 'did:web:oxy.so:u:evil' };
      await expect(verifyEnvelopeSignature(tampered)).resolves.toBe(false);
    });

    it('rejects a changed issuedAt', async () => {
      const tampered: SignedRecordEnvelope = { ...envelope, issuedAt: envelope.issuedAt + 1 };
      await expect(verifyEnvelopeSignature(tampered)).resolves.toBe(false);
    });

    it('rejects verification against an unrelated public key', async () => {
      const otherKey = generateSecp256k1KeyPair().publicKey;
      const tampered: SignedRecordEnvelope = { ...envelope, publicKey: otherKey };
      await expect(verifyEnvelopeSignature(tampered)).resolves.toBe(false);
    });
  });

  it('throws when no identity is stored', async () => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(null);
    await expect(
      SignatureService.signRecord('identity', 'did:web:oxy.so:u:u4', {}),
    ).rejects.toThrow(/No identity found/);
  });
});

describe('SignatureService.signRecordV2 / verifyEnvelopeSignature (v2 hash chain)', () => {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const privateKey = keyPair.privateKey.padStart(64, '0');

  beforeEach(() => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(privateKey);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const chain = {
    seq: 0,
    prev: null as string | null,
    collection: 'app.oxy.reputation',
    rkey: 'rt_1',
  };

  it('builds a well-formed v2 envelope carrying the chain fields', async () => {
    const subject = 'did:web:oxy.so:u:abc123';
    const envelope = await SignatureService.signRecordV2(
      'reputation_attestation',
      subject,
      { points: 25 },
      chain,
    );

    expect(envelope.version).toBe(2);
    expect(envelope.type).toBe('reputation_attestation');
    expect(envelope.subject).toBe(subject);
    expect(envelope.issuer).toBe(subject); // self-issued
    expect(envelope.seq).toBe(0);
    expect(envelope.prev).toBeNull();
    expect(envelope.collection).toBe('app.oxy.reputation');
    expect(envelope.rkey).toBe('rt_1');
    expect(envelope.publicKey).toBe(publicKey);
    expect(envelope.alg).toBe('ES256K-DER-SHA256');
    expect(typeof envelope.signature).toBe('string');
  });

  it('round-trips: a freshly signed v2 record verifies', async () => {
    const envelope = await SignatureService.signRecordV2(
      'validation_verdict',
      'did:web:oxy.so:u:v1',
      { verdict: 'approve' },
      { seq: 3, prev: 'a'.repeat(64), collection: 'app.oxy.validation', rkey: 'req_9' },
    );
    await expect(verifyEnvelopeSignature(envelope)).resolves.toBe(true);
  });

  it('covers the chain fields in the signed bytes (tampering breaks verify)', async () => {
    const envelope = await SignatureService.signRecordV2(
      'reputation_attestation',
      'did:web:oxy.so:u:t1',
      { points: 8 },
      chain,
    );

    await expect(verifyEnvelopeSignature({ ...envelope, seq: 1 })).resolves.toBe(false);
    await expect(
      verifyEnvelopeSignature({ ...envelope, prev: 'b'.repeat(64) }),
    ).resolves.toBe(false);
    await expect(
      verifyEnvelopeSignature({ ...envelope, collection: 'app.evil' }),
    ).resolves.toBe(false);
    await expect(verifyEnvelopeSignature({ ...envelope, rkey: 'other' })).resolves.toBe(false);
  });

  it('a v2 envelope signs over DIFFERENT bytes than the same base fields as v1', async () => {
    const subject = 'did:web:oxy.so:u:diff';
    const record = { x: 1 };
    const v2 = await SignatureService.signRecordV2('profile', subject, record, chain);

    const v1Input = signedRecordSigningInput({
      version: 1,
      type: 'profile',
      subject,
      issuer: subject,
      record,
      issuedAt: v2.issuedAt,
    });
    const v2Input = signedRecordSigningInput(v2);
    expect(v2Input).not.toBe(v1Input);
    expect(v2Input).toContain('"seq":0');
    expect(v2Input).toContain('"prev":null');
    expect(v2Input).toContain('"collection":"app.oxy.reputation"');
  });

  it('throws when no identity is stored', async () => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(null);
    await expect(
      SignatureService.signRecordV2('identity', 'did:web:oxy.so:u:u4', {}, chain),
    ).rejects.toThrow(/No identity found/);
  });
});
