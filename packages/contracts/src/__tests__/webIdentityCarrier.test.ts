import {
    safeParseContract,
    webIdentityEnvelopePutSchema,
    webIdentityEnvelopeResponseSchema,
    webIdentityEnvelopeSchema,
} from '../index';
import type { WebIdentityEnvelope } from '../index';

/**
 * The sealed web identity envelope is stored by the API and produced by the
 * `@oxy.so/core` carrier crypto; these tests lock the bounds that keep a
 * malformed or oversized envelope out of storage.
 */

const hex = (bytes: number, char = 'a'): string => char.repeat(bytes * 2);
const PUBLIC_KEY = `04${hex(64, 'b')}`;

const envelope: WebIdentityEnvelope = {
    version: 1,
    algorithm: 'xchacha20poly1305',
    publicKey: PUBLIC_KEY,
    entropyNonce: hex(24),
    sealedEntropy: hex(32),
    wraps: [
        {
            credentialId: 'AbCdEfGhIjKlMnOp_-12',
            nonce: hex(24),
            wrappedKey: hex(48),
            createdAt: '2026-09-16T00:00:00.000Z',
        },
    ],
};

describe('webIdentityEnvelopeSchema', () => {
    it('accepts a well-formed envelope', () => {
        expect(safeParseContract(webIdentityEnvelopeSchema, envelope)).toEqual(envelope);
    });

    it('requires Oxy’s canonical public key form (uncompressed, lowercase)', () => {
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, publicKey: `02${hex(32, 'b')}` })).toBeNull();
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, publicKey: PUBLIC_KEY.toUpperCase() })).toBeNull();
    });

    it('pins the sealed sizes, so nothing but 16 bytes of entropy and a 32-byte key can be stored', () => {
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, sealedEntropy: hex(64) })).toBeNull();
        expect(
            safeParseContract(webIdentityEnvelopeSchema, { ...envelope, wraps: [{ ...envelope.wraps[0], wrappedKey: hex(80) }] }),
        ).toBeNull();
    });

    it('needs at least one passkey and caps how many an envelope may hold', () => {
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, wraps: [] })).toBeNull();
        expect(
            safeParseContract(webIdentityEnvelopeSchema, { ...envelope, wraps: Array.from({ length: 11 }, () => envelope.wraps[0]) }),
        ).toBeNull();
    });

    it('rejects a credential id that is not base64url', () => {
        expect(
            safeParseContract(webIdentityEnvelopeSchema, { ...envelope, wraps: [{ ...envelope.wraps[0], credentialId: 'not base64url!!' }] }),
        ).toBeNull();
    });

    it('rejects an unknown version or algorithm', () => {
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, version: 2 })).toBeNull();
        expect(safeParseContract(webIdentityEnvelopeSchema, { ...envelope, algorithm: 'aes-256-gcm' })).toBeNull();
    });
});

describe('request and response shapes', () => {
    it('a PUT carries the envelope and an identity-key proof', () => {
        expect(safeParseContract(webIdentityEnvelopePutSchema, { envelope, signature: 'ab', timestamp: 1 })).not.toBeNull();
        expect(safeParseContract(webIdentityEnvelopePutSchema, { envelope })).toBeNull();
    });

    it('a response may say there is no envelope', () => {
        expect(
            safeParseContract(webIdentityEnvelopeResponseSchema, { envelope: null, phraseConfirmedAt: null, updatedAt: null }),
        ).not.toBeNull();
    });
});
