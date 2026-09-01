import { oxySignedRecordTypeSchema, signedRecordEnvelopeSchema } from '../index';
import type { OxySignedRecordType, SignedRecordEnvelope } from '../index';

/**
 * The base `signedRecordEnvelopeSchema` is now OPEN on `type` (any app may sign
 * its own records on the shared grammar); the Oxy store re-narrows with
 * `oxySignedRecordTypeSchema`. These tests lock the "open base, strict store"
 * contract — the single coordination point that unblocks app records while
 * keeping the Oxy chain strict.
 */
describe('oxySignedRecordTypeSchema (Oxy store re-narrowing)', () => {
    const oxyTypes: OxySignedRecordType[] = [
        'identity',
        'profile',
        'reputation_attestation',
        'real_life_attestation',
        'validation_verdict',
        'personhood_vouch',
        'credential',
        'node',
        'app_record',
    ];

    it('accepts every Oxy record type', () => {
        for (const type of oxyTypes) {
            expect(oxySignedRecordTypeSchema.safeParse(type).success).toBe(true);
        }
    });

    it('accepts the one app category, so an app can append to the subject’s chain', () => {
        expect(oxySignedRecordTypeSchema.safeParse('app_record').success).toBe(true);
    });

    it('rejects a bogus type and an empty string', () => {
        expect(oxySignedRecordTypeSchema.safeParse('foobar').success).toBe(false);
        expect(oxySignedRecordTypeSchema.safeParse('').success).toBe(false);
    });

    /**
     * The set stays CLOSED, which is the property that keeps the Postgres CHECK
     * and the Mongoose enum meaningful — `app_record` widened it by exactly one
     * value rather than opening a lane. An app distinguishes its records by the
     * envelope's `collection`, so a new app needs no entry here at all.
     */
    it('does not admit a per-app type alongside the shared app category', () => {
        expect(oxySignedRecordTypeSchema.safeParse('app.syra.listen').success).toBe(false);
        expect(oxySignedRecordTypeSchema.safeParse('syra_record').success).toBe(false);
    });

    it('exposes the closed set as the single source of truth (9 values, .options)', () => {
        expect([...oxySignedRecordTypeSchema.options]).toEqual(oxyTypes);
    });

    it('the base envelope ACCEPTS what the Oxy store REJECTS (open base, strict store)', () => {
        const appRecordEnvelope: SignedRecordEnvelope = {
            version: 2,
            // NOT `app_record`, which the store now accepts — the open/strict
            // split needs a type the store still refuses, or it proves nothing.
            type: 'app.syra.listen',
            subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            record: { text: 'hello from mention' },
            issuedAt: 1750000000000,
            seq: 0,
            prev: null,
            collection: 'app.mention.feed.post',
            rkey: 'post_1',
            publicKey: '02a1b2c3',
            alg: 'ES256K-DER-SHA256',
            signature: '3045...',
        };

        // The base grammar accepts any non-empty type on the shared envelope...
        expect(signedRecordEnvelopeSchema.safeParse(appRecordEnvelope).success).toBe(true);
        // ...while the Oxy store still re-narrows to its closed set.
        expect(oxySignedRecordTypeSchema.safeParse(appRecordEnvelope.type).success).toBe(false);
    });

    /**
     * The shape an app actually signs, end to end: `app_record` as the category
     * and the lexicon in `collection`. Both halves must pass, or the chain has
     * no room for an app's records.
     */
    it('accepts a real app record through BOTH the base grammar and the store gate', () => {
        const mentionPost: SignedRecordEnvelope = {
            version: 2,
            type: 'app_record',
            subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            record: { text: 'hello from mention' },
            issuedAt: 1750000000000,
            seq: 0,
            prev: null,
            collection: 'app.mention.feed.post',
            rkey: 'post_1',
            publicKey: '02a1b2c3',
            alg: 'ES256K-DER-SHA256',
            signature: '3045...',
        };

        expect(signedRecordEnvelopeSchema.safeParse(mentionPost).success).toBe(true);
        expect(oxySignedRecordTypeSchema.safeParse(mentionPost.type).success).toBe(true);
    });
});
