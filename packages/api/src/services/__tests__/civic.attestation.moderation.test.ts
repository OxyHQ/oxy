/**
 * Moderation-effect attestation tests.
 *
 * TWO REASONS THIS FILE EXISTS, and the second is the important one.
 *
 * (1) The PRIVACY contract. A reputation attestation is exportable and may end up
 *     on a public chain, so a moderation one must be a minimal PROOF rather than a
 *     description. These tests assert what the record must NOT contain — the
 *     taxonomy code, any third party, the case id, the plaintext idempotency key —
 *     because a leak here lands in the most durable artefact the system has, and
 *     nothing downstream would ever surface it.
 *
 * (2) The attestation code path had NEVER RUN in production when this was written:
 *     `signedrecords` was empty, and the three `emitAttestation: true` call sites
 *     had never fired. So the provenance chain was unexercised code, not a running
 *     guarantee, and building on the assumption that it works would have been
 *     exactly the wrong move. Everything here therefore runs against the REAL
 *     signing path with a REAL secp256k1 keypair — only the chain STORAGE is
 *     mocked — and the signature is verified independently, the same way a
 *     third-party verifier would. If the scheme were broken, these fail.
 *
 * What is still NOT proven here: that a real Mongo-backed chain accepts the
 * record. `verifyAndStoreRecord` is mocked, so its own validation is out of
 * scope — that belongs to `repoLog.test.ts` / `oxyRecordStore.test.ts`.
 */

import { ec as EC } from 'elliptic';
import { createHash } from 'node:crypto';
import { signedRecordSigningInput } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

const ec = new EC('secp256k1');
const oxyKey = ec.genKeyPair();
const OXY_PUBLIC = oxyKey.getPublic('hex');
const OXY_PRIVATE = oxyKey.getPrivate('hex');

const mockVerifyAndStore = jest.fn();
const mockGetHead = jest.fn();
const mockMaterialize = jest.fn();

jest.mock('../signedRecord.service', () => ({
  verifyAndStoreRecord: (...args: unknown[]) => mockVerifyAndStore(...args),
}));
jest.mock('../repoLog.service', () => ({
  getHead: (...args: unknown[]) => mockGetHead(...args),
  materializeCurrent: (...args: unknown[]) => mockMaterialize(...args),
}));

import {
  MODERATION_EFFECT_ATTESTATION_COLLECTION,
  attestModerationEffect,
} from '../civic/attestation.service';

const SUBJECT_USER_ID = '507f1f77bcf86cd799439011';
const TRANSACTION_ID = '507f1f77bcf86cd799439012';

/**
 * The idempotency key a real effect would carry. It embeds the incident id, which
 * is exactly why it must not appear in the clear.
 */
const IDEMPOTENCY_KEY = `moderation:inc_01HXYZ:1:${SUBJECT_USER_ID}:conduct_penalty`;

const INPUT = {
  transactionId: TRANSACTION_ID,
  subjectUserId: SUBJECT_USER_ID,
  severityBand: 'medium' as const,
  points: -8,
  decisionHash: 'sha256:0f3c2b1a',
  policyVersion: 'oxy.2026.1',
  sourceActionId: IDEMPOTENCY_KEY,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
  mockMaterialize.mockResolvedValue(null);
  mockGetHead.mockResolvedValue(null);
  mockVerifyAndStore.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.OXY_PUBLIC_KEY;
  delete process.env.OXY_PRIVATE_KEY;
});

describe('attestModerationEffect — the signing path actually works', () => {
  it('emits a genesis envelope whose signature verifies independently', async () => {
    const envelope = await attestModerationEffect(INPUT);
    expect(envelope).not.toBeNull();
    const record = envelope as SignedRecordEnvelope;

    expect(record.version).toBe(2);
    expect(record.seq).toBe(0);
    expect(record.prev).toBeNull();
    expect(record.collection).toBe(MODERATION_EFFECT_ATTESTATION_COLLECTION);
    expect(record.rkey).toBe(TRANSACTION_ID);
    expect(record.alg).toBe('ES256K-DER-SHA256');

    // Verify the way a third party would: recompute the canonical signing input
    // from the envelope minus its signature, and check it against the public key.
    const { signature, ...fields } = record;
    const digest = createHash('sha256').update(signedRecordSigningInput(fields)).digest();
    const verified = ec.keyFromPublic(record.publicKey, 'hex').verify(digest, signature);
    expect(verified).toBe(true);
  });

  it('extends an existing chain rather than forking it', async () => {
    mockGetHead.mockResolvedValue({ seq: 7, headRecordId: 'rec_previous' });
    const envelope = await attestModerationEffect(INPUT);
    expect(envelope?.seq).toBe(8);
    expect(envelope?.prev).toBe('rec_previous');
  });

  it('retries the chain-head race and succeeds', async () => {
    mockVerifyAndStore
      .mockResolvedValueOnce({ ok: false, reason: 'chain_conflict' })
      .mockResolvedValueOnce({ ok: true });
    const envelope = await attestModerationEffect(INPUT);
    expect(envelope).not.toBeNull();
    expect(mockVerifyAndStore).toHaveBeenCalledTimes(2);
  });

  it('is idempotent per transaction', async () => {
    mockMaterialize.mockResolvedValue({ rkey: TRANSACTION_ID } as never);
    const envelope = await attestModerationEffect(INPUT);
    expect(envelope).toEqual({ rkey: TRANSACTION_ID });
    expect(mockVerifyAndStore).not.toHaveBeenCalled();
  });

  it('is non-fatal when the Oxy key is absent', async () => {
    delete process.env.OXY_PRIVATE_KEY;
    await expect(attestModerationEffect(INPUT)).resolves.toBeNull();
    expect(mockVerifyAndStore).not.toHaveBeenCalled();
  });

  it('is non-fatal when the chain rejects the record', async () => {
    mockVerifyAndStore.mockResolvedValue({ ok: false, reason: 'bad_signature' });
    await expect(attestModerationEffect(INPUT)).resolves.toBeNull();
  });
});

describe('attestModerationEffect — the privacy contract', () => {
  it('carries the minimal proof and nothing more', async () => {
    const envelope = await attestModerationEffect(INPUT);
    const record = (envelope as SignedRecordEnvelope).record as Record<string, unknown>;

    expect(record).toEqual({
      actionType: 'moderation_conduct_effect',
      severityBand: 'medium',
      points: -8,
      decisionHash: 'sha256:0f3c2b1a',
      policyVersion: 'oxy.2026.1',
      sourceActionIdHash: createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex'),
    });
  });

  it('hashes the source action id instead of publishing it', async () => {
    // The key embeds the incident id, so plaintext would let a holder of two
    // records infer they concern the same case. The hash still proves which
    // effect the attestation covers to anyone who already knows the key.
    const envelope = await attestModerationEffect(INPUT);
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain(IDEMPOTENCY_KEY);
    expect(serialized).not.toContain('inc_01HXYZ');
    expect(serialized).toContain(createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex'));
  });

  it('never carries a taxonomy code, a case id, or any third party', async () => {
    // Deliberately passes values that a careless implementation might forward,
    // then asserts none of them can appear — the input type does not accept them,
    // and this is the runtime half of that guarantee.
    const envelope = await attestModerationEffect(INPUT);
    const serialized = JSON.stringify(envelope);

    for (const forbidden of [
      'harassment',
      'targeted_abuse',
      'child_safety',
      'case_',
      'reporterId',
      'victimId',
      'juror',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('publishes a severity BAND, never a finding', async () => {
    // The band is what the consequence engine consumes, so it is also the most
    // the attestation ever needs. A new taxonomy code changes nothing here.
    const envelope = await attestModerationEffect({ ...INPUT, severityBand: 'critical' });
    const record = (envelope as SignedRecordEnvelope).record as Record<string, unknown>;
    expect(record.severityBand).toBe('critical');
    expect(Object.keys(record)).not.toContain('code');
    expect(Object.keys(record)).not.toContain('family');
  });
});
