import {
    didDocumentSchema,
    signedRecordEnvelopeSchema,
    verifiedDomainSchema,
    domainVerificationRequestSchema,
    domainVerificationInstructionsSchema,
    authMethodEntrySchema,
    authMethodsResponseSchema,
    exportBundleSchema,
    userResponseSchema,
    safeParseContract,
} from '../index';
import type { DidDocument, ExportAttestation, ExportBundle, SignedRecordEnvelope } from '../index';

/**
 * The self-sovereign identity contracts MUST round-trip exactly what the API
 * emits and the Commons vault / core identity mixin produce. These tests lock
 * the load-bearing shapes (DID document, signed-record envelope, export bundle,
 * domain + auth-method schemas) so producer and consumers cannot drift.
 */

/** A self-sovereign account's DID document (holds an `identity` key). */
const selfSovereignDoc: DidDocument = {
    '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
    controller: ['did:web:oxy.so:u:507f1f77bcf86cd799439011', 'did:web:oxy.so'],
    verificationMethod: [
        {
            id: 'did:web:oxy.so:u:507f1f77bcf86cd799439011#key-1',
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            publicKeyHex: '02a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
    ],
    authentication: ['did:web:oxy.so:u:507f1f77bcf86cd799439011#key-1'],
    assertionMethod: ['did:web:oxy.so:u:507f1f77bcf86cd799439011#key-1'],
    alsoKnownAs: ['acct:nateus@oxy.so', 'https://oxy.so/@nateus', 'https://nate.com'],
    service: [
        {
            id: 'did:web:oxy.so:u:507f1f77bcf86cd799439011#oxy-api',
            type: 'OxyApi',
            serviceEndpoint: 'https://api.oxy.so',
        },
    ],
};

describe('didDocumentSchema', () => {
    it('round-trips a self-sovereign DID document', () => {
        const parsed = safeParseContract(didDocumentSchema, selfSovereignDoc);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(selfSovereignDoc);
        expect(parsed?.controller).toHaveLength(2);
        expect(parsed?.verificationMethod[0].type).toBe(
            'EcdsaSecp256k1VerificationKey2019',
        );
    });

    it('accepts a custodial DID document (Oxy-only controller, no verification methods)', () => {
        const parsed = safeParseContract(didDocumentSchema, {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            controller: ['did:web:oxy.so'],
            verificationMethod: [],
            authentication: [],
            assertionMethod: [],
            alsoKnownAs: ['acct:nateus@oxy.so'],
            service: [],
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.controller).toEqual(['did:web:oxy.so']);
        expect(parsed?.verificationMethod).toHaveLength(0);
    });

    it('rejects an unknown verification-method type', () => {
        const parsed = safeParseContract(didDocumentSchema, {
            ...selfSovereignDoc,
            verificationMethod: [
                {
                    id: 'did:web:oxy.so:u:1#key-1',
                    type: 'Ed25519VerificationKey2020',
                    controller: 'did:web:oxy.so:u:1',
                    publicKeyHex: '00',
                },
            ],
        });
        expect(parsed).toBeNull();
    });

    it('rejects a document missing the required @context', () => {
        const { '@context': _omit, ...rest } = selfSovereignDoc;
        const parsed = safeParseContract(didDocumentSchema, rest);
        expect(parsed).toBeNull();
    });
});

describe('signedRecordEnvelopeSchema', () => {
    const envelope: SignedRecordEnvelope = {
        version: 1,
        type: 'profile',
        subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
        issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
        record: { displayName: 'Nate Isern', bio: 'building Oxy' },
        issuedAt: 1750000000000,
        publicKey: '02a1b2c3d4e5f6',
        alg: 'ES256K-DER-SHA256',
        signature: '3045022100abcdef...',
    };

    it('round-trips a signed profile record', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, envelope);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(envelope);
        expect((parsed?.record as Record<string, unknown>).displayName).toBe('Nate Isern');
    });

    it('accepts the identity record type', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            type: 'identity',
            record: {},
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.type).toBe('identity');
    });

    it('rejects a wrong alg literal', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            alg: 'RS256',
        });
        expect(parsed).toBeNull();
    });

    it('accepts an open, app-defined record type (the base envelope is app-agnostic)', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            type: 'app_record',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.type).toBe('app_record');
    });

    it('rejects an empty record type', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            type: '',
        });
        expect(parsed).toBeNull();
    });

    it('round-trips a production identity envelope byte-identically under the widened type schema', () => {
        // Canonical-bytes safety: widening `type` enum→string must not reject or
        // mutate a record already in production. The parsed value equals the input
        // exactly, so the signed bytes a verifier recomputes are unchanged.
        const identityEnvelope: SignedRecordEnvelope = {
            ...envelope,
            type: 'identity',
            record: { handle: '@nate' },
        };
        const parsed = safeParseContract(signedRecordEnvelopeSchema, identityEnvelope);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(identityEnvelope);
    });

    it('rejects a version outside the {1,2} union', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            version: 3,
        });
        expect(parsed).toBeNull();
    });

    it('rejects a v1 envelope carrying v2 chain fields', () => {
        const parsed = safeParseContract(signedRecordEnvelopeSchema, {
            ...envelope,
            seq: 0,
            prev: null,
            collection: 'app.oxy.identity',
            rkey: 'self',
        });
        expect(parsed).toBeNull();
    });

    describe('v2 envelopes (per-subject hash chain)', () => {
        const v2Genesis: SignedRecordEnvelope = {
            version: 2,
            type: 'reputation_attestation',
            subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            issuer: 'did:web:oxy.so',
            record: { txnId: 'rt_1', points: 25, category: 'physical' },
            issuedAt: 1750000000000,
            seq: 0,
            prev: null,
            collection: 'app.oxy.reputation',
            rkey: 'rt_1',
            publicKey: '03oxykey',
            alg: 'ES256K-DER-SHA256',
            signature: '3046...',
        };

        it('round-trips a genesis v2 record (prev: null)', () => {
            const parsed = safeParseContract(signedRecordEnvelopeSchema, v2Genesis);
            expect(parsed).not.toBeNull();
            expect(parsed).toEqual(v2Genesis);
            expect(parsed?.version).toBe(2);
            expect(parsed?.seq).toBe(0);
            expect(parsed?.prev).toBeNull();
            expect(parsed?.collection).toBe('app.oxy.reputation');
            expect(parsed?.rkey).toBe('rt_1');
        });

        it('round-trips a non-genesis v2 record (prev points at a recordId)', () => {
            const parsed = safeParseContract(signedRecordEnvelopeSchema, {
                ...v2Genesis,
                seq: 1,
                prev: 'a'.repeat(64),
                rkey: 'rt_2',
            });
            expect(parsed).not.toBeNull();
            expect(parsed?.seq).toBe(1);
            expect(parsed?.prev).toBe('a'.repeat(64));
        });

        it('accepts an app record type carried on an app collection (app.mention.feed.post)', () => {
            const parsed = safeParseContract(signedRecordEnvelopeSchema, {
                ...v2Genesis,
                type: 'app_record',
                collection: 'app.mention.feed.post',
                rkey: 'post_1',
            });
            expect(parsed).not.toBeNull();
            expect(parsed?.type).toBe('app_record');
            expect(parsed?.collection).toBe('app.mention.feed.post');
        });

        it('accepts every widened civic record type', () => {
            const types = [
                'real_life_attestation',
                'validation_verdict',
                'personhood_vouch',
                'credential',
                'node',
            ] as const;
            for (const type of types) {
                const parsed = safeParseContract(signedRecordEnvelopeSchema, {
                    ...v2Genesis,
                    type,
                });
                expect(parsed).not.toBeNull();
                expect(parsed?.type).toBe(type);
            }
        });

        it('rejects a v2 envelope missing seq', () => {
            const { seq: _omit, ...rest } = v2Genesis;
            const parsed = safeParseContract(signedRecordEnvelopeSchema, rest);
            expect(parsed).toBeNull();
        });

        it('rejects a v2 envelope missing collection', () => {
            const { collection: _omit, ...rest } = v2Genesis;
            const parsed = safeParseContract(signedRecordEnvelopeSchema, rest);
            expect(parsed).toBeNull();
        });

        it('rejects a v2 envelope missing rkey', () => {
            const { rkey: _omit, ...rest } = v2Genesis;
            const parsed = safeParseContract(signedRecordEnvelopeSchema, rest);
            expect(parsed).toBeNull();
        });

        it('rejects a v2 envelope missing prev (genesis must use prev: null, not omit it)', () => {
            const { prev: _omit, ...rest } = v2Genesis;
            const parsed = safeParseContract(signedRecordEnvelopeSchema, rest);
            expect(parsed).toBeNull();
        });
    });
});

describe('verifiedDomainSchema', () => {
    it('accepts a dns-txt verified domain with an ISO timestamp string', () => {
        const parsed = safeParseContract(verifiedDomainSchema, {
            domain: 'nate.com',
            verifiedAt: '2026-06-26T12:00:00.000Z',
            method: 'dns-txt',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.method).toBe('dns-txt');
    });

    it('accepts a well-known verified domain with a Date instance', () => {
        const parsed = verifiedDomainSchema.parse({
            domain: 'example.org',
            verifiedAt: new Date('2026-06-26T12:00:00.000Z'),
            method: 'well-known',
        });
        expect(parsed.method).toBe('well-known');
    });

    it('rejects an unknown verification method', () => {
        const parsed = safeParseContract(verifiedDomainSchema, {
            domain: 'nate.com',
            verifiedAt: '2026-06-26T12:00:00.000Z',
            method: 'email',
        });
        expect(parsed).toBeNull();
    });
});

describe('domainVerificationRequestSchema', () => {
    it('accepts a non-empty domain', () => {
        const parsed = safeParseContract(domainVerificationRequestSchema, {
            domain: 'nate.com',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.domain).toBe('nate.com');
    });

    it('rejects an empty domain', () => {
        const parsed = safeParseContract(domainVerificationRequestSchema, { domain: '' });
        expect(parsed).toBeNull();
    });
});

describe('domainVerificationInstructionsSchema', () => {
    it('round-trips the DNS + well-known instructions', () => {
        const instructions = {
            domain: 'nate.com',
            token: 'oxy-domain-verification=abc123',
            dns: {
                name: '_oxy-identity.nate.com',
                value: 'oxy-domain-verification=abc123',
            },
            wellKnown: {
                url: 'https://nate.com/.well-known/oxy-domain',
                body: 'oxy-domain-verification=abc123',
            },
        };
        const parsed = safeParseContract(domainVerificationInstructionsSchema, instructions);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(instructions);
    });

    it('rejects instructions missing the dns block', () => {
        const parsed = safeParseContract(domainVerificationInstructionsSchema, {
            domain: 'nate.com',
            token: 't',
            wellKnown: { url: 'https://nate.com/.well-known/oxy-domain', body: 't' },
        });
        expect(parsed).toBeNull();
    });
});

describe('authMethodEntrySchema / authMethodsResponseSchema', () => {
    it('accepts an identity method carrying a verificationMethodId', () => {
        const parsed = safeParseContract(authMethodEntrySchema, {
            type: 'identity',
            linkedAt: '2026-06-26T12:00:00.000Z',
            verificationMethodId: 'did:web:oxy.so:u:1#key-1',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.verificationMethodId).toBe('did:web:oxy.so:u:1#key-1');
    });

    it('accepts a webauthn method with no verificationMethodId', () => {
        const parsed = safeParseContract(authMethodEntrySchema, {
            type: 'webauthn',
            linkedAt: '2026-06-26T12:00:00.000Z',
            credentialId: 'cred_abc',
            name: 'MacBook Touch ID',
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.verificationMethodId).toBeUndefined();
        expect(parsed?.credentialId).toBe('cred_abc');
    });

    it('rejects an unknown auth-method type', () => {
        const parsed = safeParseContract(authMethodEntrySchema, {
            type: 'magiclink',
            linkedAt: '2026-06-26T12:00:00.000Z',
        });
        expect(parsed).toBeNull();
    });

    it('round-trips the full GET /auth/methods response', () => {
        const response = {
            did: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            methods: [
                {
                    type: 'identity',
                    linkedAt: '2026-06-26T12:00:00.000Z',
                    verificationMethodId: 'did:web:oxy.so:u:1#key-1',
                },
                { type: 'webauthn', linkedAt: '2026-06-26T12:01:00.000Z', credentialId: 'cred_abc', name: 'Passkey' },
            ],
        };
        const parsed = safeParseContract(authMethodsResponseSchema, response);
        expect(parsed).not.toBeNull();
        expect(parsed?.methods).toHaveLength(2);
        expect(parsed?.did).toBe('did:web:oxy.so:u:507f1f77bcf86cd799439011');
    });
});

describe('exportBundleSchema', () => {
    const attestation: ExportAttestation = {
        issuer: 'did:web:oxy.so',
        publicKey: '03oxykey',
        alg: 'ES256K-DER-SHA256',
        signature: '3046...',
        signedAt: 1750000001000,
    };

    const bundle: ExportBundle = {
        '$schema': 'https://oxy.so/schemas/export-bundle/v1.json',
        exportedAt: '2026-06-26T12:00:00.000Z',
        did: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
        didDocument: selfSovereignDoc,
        profile: { username: 'nateus', name: { displayName: 'Nate Isern' } },
        verifiedDomains: [
            { domain: 'nate.com', verifiedAt: '2026-06-26T12:00:00.000Z', method: 'dns-txt' },
        ],
        authMethods: [
            {
                type: 'identity',
                linkedAt: '2026-06-26T12:00:00.000Z',
                verificationMethodId: 'did:web:oxy.so:u:1#key-1',
            },
        ],
        signedRecords: [
            {
                version: 1,
                type: 'profile',
                subject: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
                issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
                record: { displayName: 'Nate Isern' },
                issuedAt: 1750000000000,
                publicKey: '02a1b2c3',
                alg: 'ES256K-DER-SHA256',
                signature: '3045...',
            },
        ],
        appData: [{ app: 'mention', posts: 3 }],
        social: {
            following: ['did:web:oxy.so:u:aaa'],
            followers: ['did:web:oxy.so:u:bbb', 'did:web:oxy.so:u:ccc'],
        },
        financial: {
            receipts: [
                {
                    receiptId: 'rcpt_1',
                    requestId: 'req_1',
                    settledAt: '2026-06-26T11:59:00.000Z',
                    // An exact decimal STRING. A JSON number cannot carry it, and a
                    // bill the subject re-adds must reproduce what Oxy charged.
                    billedAmount: '0.000002100000',
                    currency: 'USD',
                    outcome: 'completed',
                    resolvedModelReference: 'oxy/small-1',
                    servingProvider: 'oxy-hosted',
                    platformFeeOnly: false,
                },
            ],
            ledgerEntries: [
                {
                    entryId: 'led_1',
                    kind: 'settlement',
                    currency: 'USD',
                    createdAt: '2026-06-26T11:59:00.000Z',
                },
            ],
            reservations: [
                {
                    reservationId: 'resv_1',
                    requestId: 'req_1',
                    status: 'settled',
                    reservedAmount: '0.000010000000',
                    currency: 'USD',
                    createdAt: '2026-06-26T11:58:00.000Z',
                    expiresAt: '2026-06-26T12:03:00.000Z',
                },
            ],
        },
        attestation,
    };

    it('round-trips a full export bundle (Oxy attestation, no client proof)', () => {
        const parsed = safeParseContract(exportBundleSchema, bundle);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(bundle);
        expect(parsed?.proof).toBeUndefined();
        expect(parsed?.attestation?.issuer).toBe('did:web:oxy.so');
    });

    it('round-trips a bundle with attestation:null (Oxy custodial key unset, dev/pre-prod)', () => {
        const parsed = safeParseContract(exportBundleSchema, { ...bundle, attestation: null });
        expect(parsed).not.toBeNull();
        expect(parsed?.attestation).toBeNull();
    });

    it('accepts a bundle with an optional client proof', () => {
        const parsed = safeParseContract(exportBundleSchema, {
            ...bundle,
            proof: {
                issuer: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
                publicKey: '02a1b2c3',
                alg: 'ES256K-DER-SHA256',
                signature: '3047...',
                signedAt: 1750000002000,
            },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.proof?.issuer).toBe('did:web:oxy.so:u:507f1f77bcf86cd799439011');
    });

    it('rejects a bundle whose attestation alg is wrong', () => {
        const parsed = safeParseContract(exportBundleSchema, {
            ...bundle,
            attestation: { ...attestation, alg: 'ES256' },
        });
        expect(parsed).toBeNull();
    });

    it('rejects a bundle missing the embedded DID document', () => {
        const { didDocument: _omit, ...rest } = bundle;
        const parsed = safeParseContract(exportBundleSchema, rest);
        expect(parsed).toBeNull();
    });

    /**
     * The financial section is REQUIRED, and empty arrays are the normal answer
     * (#972 section 12).
     *
     * Required rather than optional so a producer cannot answer a subject-access
     * request by omitting the section — an absent key and "you were charged
     * nothing" are the same bytes to a reader, and only one of them is a claim
     * anybody made.
     */
    it('rejects a bundle with no financial section, and accepts three empty arrays', () => {
        const { financial: _omit, ...rest } = bundle;
        expect(safeParseContract(exportBundleSchema, rest)).toBeNull();

        const empty = safeParseContract(exportBundleSchema, {
            ...bundle,
            financial: { receipts: [], ledgerEntries: [], reservations: [] },
        });
        expect(empty).not.toBeNull();
        expect(empty?.financial.receipts).toEqual([]);
    });

    it('rejects a billed amount expressed as a JSON number', () => {
        const parsed = safeParseContract(exportBundleSchema, {
            ...bundle,
            financial: {
                ...bundle.financial,
                receipts: [{ ...bundle.financial.receipts[0], billedAmount: 0.0000021 }],
            },
        });
        expect(parsed).toBeNull();
    });
});

describe('userResponseSchema — pinned did + verifiedDomains', () => {
    it('accepts a user carrying did and verifiedDomains', () => {
        const parsed = safeParseContract(userResponseSchema, {
            id: '507f1f77bcf86cd799439011',
            username: 'nateus',
            name: { displayName: 'Nate Isern' },
            did: 'did:web:oxy.so:u:507f1f77bcf86cd799439011',
            verifiedDomains: [
                { domain: 'nate.com', verifiedAt: '2026-06-26T12:00:00.000Z', method: 'dns-txt' },
            ],
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.did).toBe('did:web:oxy.so:u:507f1f77bcf86cd799439011');
        expect(parsed?.verifiedDomains?.[0].domain).toBe('nate.com');
    });

    it('still accepts a user without did/verifiedDomains (both optional)', () => {
        const parsed = safeParseContract(userResponseSchema, {
            id: '507f1f77bcf86cd799439011',
            name: { displayName: 'Nate' },
        });
        expect(parsed).not.toBeNull();
        expect(parsed?.did).toBeUndefined();
        expect(parsed?.verifiedDomains).toBeUndefined();
    });

    it('rejects a verifiedDomains entry with an invalid method', () => {
        const parsed = safeParseContract(userResponseSchema, {
            id: '507f1f77bcf86cd799439011',
            name: { displayName: 'Nate' },
            verifiedDomains: [
                { domain: 'nate.com', verifiedAt: '2026-06-26T12:00:00.000Z', method: 'carrier-pigeon' },
            ],
        });
        expect(parsed).toBeNull();
    });
});
