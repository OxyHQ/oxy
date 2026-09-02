/**
 * Signed-record envelope tests — the protocol's canonical signing input,
 * content address, and explicit-key sign/verify.
 *
 * Includes the byte-stability regression guards moved from `@oxyhq/core`'s
 * signed-record suite (the v1 signing-input string and the deterministic
 * `computeRecordId`), plus a CANONICAL-BYTES FIXTURE: signing a fixed envelope
 * with a fixed key must produce the exact same signing input, recordId, derived
 * publicKey, and DER signature as before the crypto was moved into protocol.
 * Any drift here invalidates every production signature, so the literals are
 * locked.
 */

import { deriveSecp256k1PublicKey } from '../secp256k1';
import { signedRecordEnvelopeSchema } from '@oxyhq/contracts';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  canonicalize,
  signedRecordSigningInput,
  computeRecordId,
  sha256,
  signMessage,
  verifySignature,
  signEnvelope,
  verifyEnvelopeSignature,
} from '../index';

describe('signedRecordSigningInput — v1 byte stability (regression guard)', () => {
  it('produces the exact original canonical bytes for a v1 record', () => {
    const input = signedRecordSigningInput({
      version: 1,
      type: 'identity',
      subject: 'did:web:oxy.so:u:u1',
      issuer: 'did:web:oxy.so:u:u1',
      record: { handle: '@nate' },
      issuedAt: 1750000000000,
    });
    expect(input).toBe(
      '{"issuedAt":1750000000000,"issuer":"did:web:oxy.so:u:u1","record":{"handle":"@nate"},"subject":"did:web:oxy.so:u:u1","type":"identity","version":1}',
    );
  });

  it('does NOT include any v2 chain fields for a v1 record even if they are passed', () => {
    const input = signedRecordSigningInput({
      version: 1,
      type: 'identity',
      subject: 'did:web:oxy.so:u:u1',
      issuer: 'did:web:oxy.so:u:u1',
      record: { handle: '@nate' },
      issuedAt: 1750000000000,
      // These must be ignored by the v1 branch — proving v1 bytes are immutable.
      seq: 5,
      prev: 'deadbeef',
      collection: 'app.oxy.identity',
      rkey: 'self',
    });
    expect(input).not.toContain('seq');
    expect(input).not.toContain('prev');
    expect(input).not.toContain('collection');
    expect(input).not.toContain('rkey');
    expect(input).toBe(
      '{"issuedAt":1750000000000,"issuer":"did:web:oxy.so:u:u1","record":{"handle":"@nate"},"subject":"did:web:oxy.so:u:u1","type":"identity","version":1}',
    );
  });

  it('a v2 record signs over DIFFERENT bytes than the same base fields as v1', () => {
    const base = {
      type: 'profile' as const,
      subject: 'did:web:oxy.so:u:diff',
      issuer: 'did:web:oxy.so:u:diff',
      record: { x: 1 },
      issuedAt: 1750000000000,
    };
    const v1Input = signedRecordSigningInput({ version: 1, ...base });
    const v2Input = signedRecordSigningInput({
      version: 2,
      ...base,
      seq: 0,
      prev: null,
      collection: 'app.oxy.reputation',
      rkey: 'rt_1',
    });
    expect(v2Input).not.toBe(v1Input);
    expect(v2Input).toContain('"seq":0');
    expect(v2Input).toContain('"prev":null');
    expect(v2Input).toContain('"collection":"app.oxy.reputation"');
  });
});

describe('computeRecordId — deterministic content address', () => {
  const base: SignedRecordEnvelope = {
    version: 2,
    type: 'reputation_attestation',
    subject: 'did:web:oxy.so:u:rid',
    issuer: 'did:web:oxy.so',
    record: { points: 25 },
    issuedAt: 1750000000000,
    seq: 0,
    prev: null,
    collection: 'app.oxy.reputation',
    rkey: 'rt_1',
    publicKey: '03oxykey',
    alg: 'ES256K-DER-SHA256',
    signature: 'sig-is-not-part-of-the-id',
  };

  it('is a 64-char lowercase hex SHA-256 digest', async () => {
    const id = await computeRecordId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical signing fields', async () => {
    const a = await computeRecordId(base);
    const b = await computeRecordId(base);
    expect(a).toBe(b);
  });

  it('equals sha256 of the canonical signing input (content address, excludes publicKey/signature)', async () => {
    const id = await computeRecordId(base);
    const expected = await sha256(signedRecordSigningInput(base));
    expect(id).toBe(expected);
    // Changing only signature/publicKey does NOT change the recordId.
    const sameId = await computeRecordId({
      ...base,
      signature: 'totally-different',
      publicKey: 'different-key',
    });
    expect(sameId).toBe(id);
  });

  it('changes when any signed field changes', async () => {
    const id = await computeRecordId(base);
    expect(await computeRecordId({ ...base, seq: 1 })).not.toBe(id);
    expect(await computeRecordId({ ...base, record: { points: 26 } })).not.toBe(id);
    expect(await computeRecordId({ ...base, prev: 'a'.repeat(64) })).not.toBe(id);
  });

  it('a v1 record and a v2 record with the same base fields have different recordIds', async () => {
    const v1Id = await computeRecordId({
      version: 1,
      type: 'profile',
      subject: 'did:web:oxy.so:u:rid',
      issuer: 'did:web:oxy.so:u:rid',
      record: { points: 25 },
      issuedAt: 1750000000000,
    });
    const v2Id = await computeRecordId({
      version: 2,
      type: 'profile',
      subject: 'did:web:oxy.so:u:rid',
      issuer: 'did:web:oxy.so:u:rid',
      record: { points: 25 },
      issuedAt: 1750000000000,
      seq: 0,
      prev: null,
      collection: 'app.oxy.profile',
      rkey: 'self',
    });
    expect(v1Id).not.toBe(v2Id);
  });
});

/**
 * CANONICAL-BYTES FIXTURE — the load-bearing "did the move change anything?"
 * guard. A fixed private key (a well-known secp256k1 test scalar) signing a
 * fixed v2 envelope must reproduce these exact bytes. The signer uses RFC 6979
 * deterministic nonces, so the DER signature is reproducible.
 */
describe('canonical-bytes fixture (move-invariance guard)', () => {
  const PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const PUBLIC_KEY =
    '044e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e47fd35c4215d1edf53e6f83de344615ce719bdb0fd878f6ed76f06dd277956de';
  const FIELDS = {
    version: 2 as const,
    type: 'app_record',
    subject: 'did:web:oxy.so:u:fixture',
    issuer: 'did:web:oxy.so:u:fixture',
    record: { hello: 'world', n: 1 },
    issuedAt: 1750000000000,
    seq: 0,
    prev: null as string | null,
    collection: 'app.mention.feed.post',
    rkey: 'r1',
  };
  const EXPECTED_SIGNING_INPUT =
    '{"collection":"app.mention.feed.post","issuedAt":1750000000000,"issuer":"did:web:oxy.so:u:fixture","prev":null,"record":{"hello":"world","n":1},"rkey":"r1","seq":0,"subject":"did:web:oxy.so:u:fixture","type":"app_record","version":2}';
  const EXPECTED_RECORD_ID = '46585cdd862525a1437d1fbd17d060ed053b978bb0f9095a3f22818719cab6d1';
  const EXPECTED_SIGNATURE =
    '304602210098643efdead01cb84c9ba2162fc7d013ccdb10fe4ce34fe4c52df9e1cfc9e7f7022100c7a94ac532cff4a61d4301b12aeea0598a47ad2a664a8f521f89d68deda63656';

  it('signing input matches the locked canonical bytes', () => {
    expect(signedRecordSigningInput(FIELDS)).toBe(EXPECTED_SIGNING_INPUT);
  });

  it('recordId matches the locked content address', async () => {
    expect(await computeRecordId(FIELDS)).toBe(EXPECTED_RECORD_ID);
  });

  it('signEnvelope derives the matching public key and the locked signature', async () => {
    const env = await signEnvelope(FIELDS, PRIVATE_KEY);
    expect(env.publicKey).toBe(PUBLIC_KEY);
    expect(env.alg).toBe('ES256K-DER-SHA256');
    expect(env.signature).toBe(EXPECTED_SIGNATURE);
    // The derived key is the standard uncompressed SEC1 point for this scalar.
    expect(env.publicKey).toBe(deriveSecp256k1PublicKey(PRIVATE_KEY));
  });

  it('signEnvelope is deterministic (RFC 6979) — same input, same signature', async () => {
    const a = await signEnvelope(FIELDS, PRIVATE_KEY);
    const b = await signEnvelope(FIELDS, PRIVATE_KEY);
    expect(a.signature).toBe(b.signature);
  });

  it('round-trips: the signed envelope verifies and tampering breaks it', async () => {
    const env = await signEnvelope(FIELDS, PRIVATE_KEY);
    await expect(verifyEnvelopeSignature(env)).resolves.toBe(true);
    await expect(verifyEnvelopeSignature({ ...env, seq: 1 })).resolves.toBe(false);
    await expect(
      verifyEnvelopeSignature({ ...env, record: { hello: 'tampered', n: 1 } }),
    ).resolves.toBe(false);
  });

  it('low-level signMessage / verifySignature agree over the canonical input', async () => {
    const sig = await signMessage(EXPECTED_SIGNING_INPUT, PRIVATE_KEY);
    expect(sig).toBe(EXPECTED_SIGNATURE);
    await expect(verifySignature(EXPECTED_SIGNING_INPUT, sig, PUBLIC_KEY)).resolves.toBe(true);
    await expect(verifySignature(EXPECTED_SIGNING_INPUT, sig, 'not-a-key')).resolves.toBe(false);
    expect(canonicalize(FIELDS)).toBe(EXPECTED_SIGNING_INPUT);
  });

  /**
   * A2 type-widening guard: opening the envelope `type` from a closed enum to a
   * string is canonical-bytes-safe AND lets app records onto the shared grammar.
   * `signedRecordEnvelopeSchema` (the widened contract) is exercised end-to-end
   * against the real signer/verifier — the schema change must not reject or alter
   * a production envelope, and an `app.mention.*` record must now validate.
   */
  it('the widened base schema accepts a production identity envelope with unchanged canonical bytes', async () => {
    const identityFields = {
      version: 1 as const,
      type: 'identity',
      subject: 'did:web:oxy.so:u:u1',
      issuer: 'did:web:oxy.so:u:u1',
      record: { handle: '@nate' },
      issuedAt: 1750000000000,
    };
    const signed = await signEnvelope(identityFields, PRIVATE_KEY);
    // The widened schema accepts the production envelope unchanged.
    const parsed = signedRecordEnvelopeSchema.safeParse(signed);
    expect(parsed.success).toBe(true);
    // Its canonical signing bytes are byte-identical to the locked v1 golden —
    // the enum→string widening does not touch what the signature covers.
    expect(signedRecordSigningInput(signed)).toBe(
      '{"issuedAt":1750000000000,"issuer":"did:web:oxy.so:u:u1","record":{"handle":"@nate"},"subject":"did:web:oxy.so:u:u1","type":"identity","version":1}',
    );
    await expect(verifyEnvelopeSignature(signed)).resolves.toBe(true);
  });

  it('the widened base schema accepts the signed app_record envelope (app.mention.feed.post)', async () => {
    const signed = await signEnvelope(FIELDS, PRIVATE_KEY);
    expect(signed.type).toBe('app_record');
    expect(signed.collection).toBe('app.mention.feed.post');
    const parsed = signedRecordEnvelopeSchema.safeParse(signed);
    expect(parsed.success).toBe(true);
    await expect(verifyEnvelopeSignature(signed)).resolves.toBe(true);
  });
});
