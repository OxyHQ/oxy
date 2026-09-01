import {
    transparencyCheckpointSchema,
    transparencyCheckpointSignatureSchema,
    transparencyInclusionProofSchema,
} from '../index';
import type { TransparencyCheckpoint, TransparencyInclusionProof } from '../index';

/**
 * The transparency log is the surface a third party uses to audit Oxy WITHOUT
 * trusting it, so its wire contract is load-bearing: a verifier recomputes the
 * committed root from these exact fields. These tests lock the shapes that make
 * that possible — a `null`-able previous-checkpoint link (genesis), an
 * always-present signature set, and hex digests that cannot silently be
 * truncated or upper-cased into a different string than the one that was hashed.
 */

const SIGNATURE = {
    publicKey: '04'.padEnd(130, 'a'),
    alg: 'ES256K-DER-SHA256' as const,
    signature: '3045022100'.padEnd(140, 'b'),
};

const CHECKPOINT: TransparencyCheckpoint = {
    index: 7,
    periodEnd: 1_800_000_000_000,
    treeSize: 3,
    root: 'a'.repeat(64),
    prevCheckpointHash: 'b'.repeat(64),
    signatures: [SIGNATURE],
    anchors: [
        {
            network: 'faircoin-main',
            txid: 'c'.repeat(64),
            confirmations: 12,
            anchoredAt: 1_800_000_060_000,
        },
    ],
};

describe('transparencyCheckpointSchema', () => {
    it('accepts a signed, anchored checkpoint', () => {
        expect(transparencyCheckpointSchema.safeParse(CHECKPOINT).success).toBe(true);
    });

    it('accepts the genesis checkpoint, whose previous link is null', () => {
        const genesis = { ...CHECKPOINT, index: 0, prevCheckpointHash: null };
        expect(transparencyCheckpointSchema.safeParse(genesis).success).toBe(true);
    });

    it('accepts a checkpoint that is published but not yet anchored', () => {
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, anchors: [] }).success).toBe(true);
    });

    it('accepts an empty tree (no chained subjects yet)', () => {
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, treeSize: 0 }).success).toBe(true);
    });

    it('rejects an unsigned checkpoint — an unsigned root commits nobody', () => {
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, signatures: [] }).success).toBe(false);
    });

    it('rejects a root that is not a 64-char lowercase hex digest', () => {
        for (const root of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(62)}zz`, '']) {
            expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, root }).success).toBe(false);
        }
    });

    it('rejects a negative or fractional index', () => {
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, index: -1 }).success).toBe(false);
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, index: 1.5 }).success).toBe(false);
    });

    it('rejects a negative tree size', () => {
        expect(transparencyCheckpointSchema.safeParse({ ...CHECKPOINT, treeSize: -1 }).success).toBe(false);
    });
});

describe('transparencyCheckpointSignatureSchema', () => {
    it('accepts the protocol signature algorithm', () => {
        expect(transparencyCheckpointSignatureSchema.safeParse(SIGNATURE).success).toBe(true);
    });

    it('rejects any other algorithm, so a weaker scheme cannot be smuggled in', () => {
        const other = { ...SIGNATURE, alg: 'HS256' };
        expect(transparencyCheckpointSignatureSchema.safeParse(other).success).toBe(false);
    });
});

describe('transparencyInclusionProofSchema', () => {
    const PROOF: TransparencyInclusionProof = {
        checkpoint: CHECKPOINT,
        subjectDid: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
        seq: 4,
        headRecordId: 'd'.repeat(64),
        leaf: 'e'.repeat(64),
        leafIndex: 2,
        proof: ['f'.repeat(64), '0'.repeat(64)],
    };

    it('accepts a proof carrying the leaf preimage the verifier re-hashes', () => {
        expect(transparencyInclusionProofSchema.safeParse(PROOF).success).toBe(true);
    });

    it('accepts the empty audit path of a single-leaf tree', () => {
        const single = { ...PROOF, leafIndex: 0, proof: [], checkpoint: { ...CHECKPOINT, treeSize: 1 } };
        expect(transparencyInclusionProofSchema.safeParse(single).success).toBe(true);
    });

    it('rejects a path step that is not a hex digest', () => {
        const bad = { ...PROOF, proof: ['not-a-digest'] };
        expect(transparencyInclusionProofSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects a negative leaf index', () => {
        expect(transparencyInclusionProofSchema.safeParse({ ...PROOF, leafIndex: -1 }).success).toBe(false);
    });

    it('requires the checkpoint the proof is against', () => {
        const { checkpoint: _omitted, ...withoutCheckpoint } = PROOF;
        expect(transparencyInclusionProofSchema.safeParse(withoutCheckpoint).success).toBe(false);
    });
});
