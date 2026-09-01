/**
 * Self-sovereign identity API contracts.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of Oxy's AtProto/Bluesky-flavoured
 * identity & portability layer: the W3C DID document the API derives on demand,
 * the signed-record envelope clients sign with their cryptographic key (and the
 * server verifies), the verified-domain badge, the auth-method ↔ DID
 * verification-method mapping, and the signed data-export ("credible exit")
 * bundle. The API validates its OUTPUT against these schemas; every consumer
 * (the Commons vault app, `@oxyhq/core`'s identity mixin) validates its INPUT
 * against the same definitions, so producer and consumers cannot drift.
 *
 * Design anchors (from the identity-layer plan):
 *  - DID = `did:web:oxy.so:u:<userId>` — anchored on the stable account id, NOT
 *    the keypair. The keypair is a *verification method* that maps 1:1 to the
 *    existing `authMethods[]`. Custodial (password-only) users get a DID
 *    controlled solely by Oxy (`OXY_DID`); creating a Commons key upgrades them
 *    to self-sovereign (`controller = [userDid, OXY_DID]`); fully reversible.
 *  - Verification methods use the secp256k1 `EcdsaSecp256k1VerificationKey2019`
 *    type with `publicKeyHex` for now (a `Multikey`/`publicKeyMultibase` form may
 *    be added later — see the plan's open risks).
 *  - Signed records carry an envelope whose signing input is the canonical-JSON
 *    of every field EXCEPT `publicKey` and `signature`; `alg` is
 *    `ES256K-DER-SHA256` (secp256k1 over the SHA-256 of the canonical bytes,
 *    DER-encoded signature) — the same scheme `SignatureService` uses.
 *
 * Explicit-`interface` exports (DidDocument, SignedRecordEnvelope, ExportBundle,
 * VerifiedDomain, AuthMethodsResponse and their sub-parts) follow the same
 * rationale as `UserNameResponse` in `./userResponse`: a `z.infer<>` of a nested
 * object schema can degrade under a consumer's `moduleResolution: "node"`
 * (node10) resolution, so the load-bearing response shapes are declared as
 * literal interfaces and the runtime schemas are annotated `z.ZodType<Interface>`
 * — the emitted `.d.ts` then states the field types verbatim and survives BOTH
 * `node` and `bundler` resolution. Request schemas (no nested-object hazard) are
 * inferred via `z.infer<>`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  DID document (W3C DID core)                                               */
/* -------------------------------------------------------------------------- */

/**
 * A `EcdsaSecp256k1VerificationKey2019` verification method — the canonical Oxy
 * key form. Mirrors the secp256k1 key entries the API derives from
 * `User.publicKey` + each `authMethods[]` of type `identity`. `id` is a fragment
 * reference within the DID document (e.g. `did:web:oxy.so:u:<id>#key-1`);
 * `controller` is the controlling DID; `publicKeyHex` is the (uncompressed)
 * secp256k1 public key in hex.
 */
export interface Secp256k1VerificationMethod {
    id: string;
    type: 'EcdsaSecp256k1VerificationKey2019';
    controller: string;
    publicKeyHex: string;
}

/**
 * A `Multikey` verification method — the AtProto/Bluesky key form. The SAME
 * secp256k1 key as an account's {@link Secp256k1VerificationMethod}, re-encoded
 * the way atproto expects: `publicKeyMultibase` is the `did:key`-style multibase
 * (`base58btc`, leading `z`) of the multicodec-prefixed (`0xe7 0x01`, secp256k1)
 * COMPRESSED public key. This is the verification method a foreign Bluesky
 * AppView reads when it routes to the user's bridge PDS; it is additive and only
 * present for atproto-bridged self-sovereign accounts.
 */
export interface MultikeyVerificationMethod {
    id: string;
    type: 'Multikey';
    controller: string;
    publicKeyMultibase: string;
}

/**
 * A single DID verification method — either the canonical Oxy secp256k1 form
 * ({@link Secp256k1VerificationMethod}) or the atproto `Multikey` form
 * ({@link MultikeyVerificationMethod}). Discriminated on `type`, so an
 * `EcdsaSecp256k1VerificationKey2019` entry keeps its exact `publicKeyHex` shape
 * (every document already served verifies byte-identically) and the `Multikey`
 * entry carries `publicKeyMultibase`.
 */
export type VerificationMethod = Secp256k1VerificationMethod | MultikeyVerificationMethod;

// The option schemas are left UN-annotated so they keep their concrete
// `ZodObject` type — `z.discriminatedUnion` requires object options and an
// explicit `z.ZodType<>` annotation would erase the shape it discriminates on.
// `z.object` already infers each option's type exactly (id/type/controller +
// the key field), so the union is structurally `VerificationMethod`.
const secp256k1VerificationMethodSchema = z.object({
    id: z.string(),
    type: z.literal('EcdsaSecp256k1VerificationKey2019'),
    controller: z.string(),
    publicKeyHex: z.string(),
});

const multikeyVerificationMethodSchema = z.object({
    id: z.string(),
    type: z.literal('Multikey'),
    controller: z.string(),
    publicKeyMultibase: z.string(),
});

export const verificationMethodSchema = z.discriminatedUnion('type', [
    secp256k1VerificationMethodSchema,
    multikeyVerificationMethodSchema,
]);

/**
 * A DID service entry (the `service[]` array). Oxy publishes its API root and
 * profile endpoints here so a resolver can discover where to fetch the user's
 * data. `serviceEndpoint` is a URL string.
 */
export interface DidService {
    id: string;
    type: string;
    serviceEndpoint: string;
}

export const didServiceSchema: z.ZodType<DidService> = z.object({
    id: z.string(),
    type: z.string(),
    serviceEndpoint: z.string(),
});

/**
 * A W3C DID document derived on demand by the API (no stored document).
 *
 * - `controller` is `[userDid, OXY_DID]` for a self-sovereign account (it holds
 *   at least one `identity` verification method) or `[OXY_DID]` for a custodial
 *   (password-only) account.
 * - `verificationMethod[]` is composed from the account's secp256k1 keys.
 * - `authentication` / `assertionMethod` reference verification-method ids.
 * - `alsoKnownAs[]` carries the account's other identifiers (`acct:` handle,
 *   profile URL, any verified-domain URLs).
 */
export interface DidDocument {
    '@context': string[];
    id: string;
    controller: string[];
    verificationMethod: VerificationMethod[];
    authentication: string[];
    assertionMethod: string[];
    alsoKnownAs: string[];
    service: DidService[];
}

export const didDocumentSchema: z.ZodType<DidDocument> = z.object({
    '@context': z.array(z.string()),
    id: z.string(),
    controller: z.array(z.string()),
    verificationMethod: z.array(verificationMethodSchema),
    authentication: z.array(z.string()),
    assertionMethod: z.array(z.string()),
    alsoKnownAs: z.array(z.string()),
    service: z.array(didServiceSchema),
});

/* -------------------------------------------------------------------------- */
/*  Signed records                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A signed record envelope. `record` is the arbitrary payload; the signing
 * input is the canonical-JSON of every envelope field EXCEPT `publicKey` and
 * `signature`. `subject` and `issuer` are DIDs (the subject the record is about
 * and the signer's DID — equal for self-issued records, `OXY_DID` for a
 * custodial provenance attestation). `issuedAt` is epoch milliseconds.
 *
 * ## `type` — open by design
 *
 * `type` is an OPEN, non-empty string: it is the application-defined category of
 * the record (e.g. Oxy's `identity`/`profile`/civic types, or `app.mention.*`'s
 * `app_record`). The base envelope is app-agnostic, so it cannot enumerate every
 * app's record categories — each app re-narrows `type` to its own closed set on
 * the way INTO its own store (Oxy via {@link OxySignedRecordType}; an app via
 * its own constant). Widening `type` from a closed enum to a string is
 * canonical-bytes-safe: {@link signedRecordSigningInput} serializes `type` as the
 * same JSON string either way, so every record already signed in production
 * verifies byte-for-byte.
 *
 * ## Versioning
 *
 * - **v1** is the original shape (`{version, type, subject, issuer, record,
 *   issuedAt}` + `publicKey/alg/signature`). It carries NONE of the v2 chain
 *   fields and remains accepted unchanged — every `identity`/`profile` record
 *   already in production verifies byte-identically.
 * - **v2** adds a per-subject hash-chain (an append-only "personal blockchain"
 *   of a single signer, no consensus/mining). The four chain fields are part of
 *   the signed bytes (so the chain cannot be forged):
 *     - `seq` — strictly-increasing sequence number per subject.
 *     - `prev` — the `recordId` (content address) of the previous record in this
 *       subject's chain, or `null` at genesis.
 *     - `collection` + `rkey` — an AtProto-style record key (e.g.
 *       `collection: 'app.oxy.identity'`, `rkey: 'self'`) used for
 *       materialization and last-writer-wins reconciliation.
 *
 * The chain fields are OPTIONAL on the interface so v1 envelopes (which omit
 * them) still type-check; the schema enforces "present iff version === 2".
 */
export interface SignedRecordEnvelope {
    version: 1 | 2;
    /** App-defined record category (open string); each store re-narrows it. */
    type: string;
    subject: string;
    issuer: string;
    record: Record<string, unknown>;
    issuedAt: number;
    /** v2 only: strictly-increasing sequence number for this subject's chain. */
    seq?: number;
    /** v2 only: `recordId` of the previous record in the chain, `null` at genesis. */
    prev?: string | null;
    /** v2 only: AtProto-style collection namespace (e.g. `app.oxy.identity`). */
    collection?: string;
    /** v2 only: AtProto-style record key within the collection (e.g. `self`). */
    rkey?: string;
    publicKey: string;
    alg: 'ES256K-DER-SHA256';
    signature: string;
}

export const signedRecordEnvelopeSchema: z.ZodType<SignedRecordEnvelope> = z
    .object({
        version: z.union([z.literal(1), z.literal(2)]),
        // Open, app-defined category (see the `type` doc above). The Oxy STORE
        // re-narrows to `oxySignedRecordTypeSchema`; an app to its own constant.
        type: z.string().min(1),
        subject: z.string(),
        issuer: z.string(),
        record: z.record(z.unknown()),
        issuedAt: z.number(),
        seq: z.number().int().nonnegative().optional(),
        prev: z.string().nullable().optional(),
        collection: z.string().min(1).optional(),
        rkey: z.string().min(1).optional(),
        publicKey: z.string(),
        alg: z.literal('ES256K-DER-SHA256'),
        signature: z.string(),
    })
    .superRefine((env, ctx) => {
        if (env.version === 2) {
            // v2 REQUIRES the hash-chain fields. `prev` may be `null` at genesis,
            // but the key must be present (it is part of the signed bytes), so we
            // reject only when it is entirely absent.
            if (typeof env.seq !== 'number') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v2 envelope requires `seq`',
                    path: ['seq'],
                });
            }
            if (env.prev === undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v2 envelope requires `prev` (use `null` at genesis)',
                    path: ['prev'],
                });
            }
            if (typeof env.collection !== 'string') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v2 envelope requires `collection`',
                    path: ['collection'],
                });
            }
            if (typeof env.rkey !== 'string') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v2 envelope requires `rkey`',
                    path: ['rkey'],
                });
            }
        } else {
            // v1 FORBIDS the v2 chain fields entirely, so a legacy envelope keeps
            // its exact byte shape and cannot smuggle unsigned chain metadata.
            if (env.seq !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v1 envelope must not carry `seq`',
                    path: ['seq'],
                });
            }
            if (env.prev !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v1 envelope must not carry `prev`',
                    path: ['prev'],
                });
            }
            if (env.collection !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v1 envelope must not carry `collection`',
                    path: ['collection'],
                });
            }
            if (env.rkey !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'v1 envelope must not carry `rkey`',
                    path: ['rkey'],
                });
            }
        }
    });

/* -------------------------------------------------------------------------- */
/*  Verified domains (badge)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A proven domain ownership badge. `method` records how ownership was proven —
 * a DNS-TXT record (`_oxy-identity.<domain>`) or a `/.well-known/oxy-domain`
 * HTTP file. `verifiedAt` is a string on the wire (ISO timestamp) but accepts a
 * `Date` so the API can validate its own pre-serialization model objects.
 */
export interface VerifiedDomain {
    domain: string;
    verifiedAt: string | Date;
    method: 'dns-txt' | 'well-known';
}

export const verifiedDomainSchema: z.ZodType<VerifiedDomain> = z.object({
    domain: z.string(),
    verifiedAt: z.union([z.string(), z.date()]),
    method: z.enum(['dns-txt', 'well-known']),
});

/** Request body for `POST /identity/domains` — the domain to start verifying. */
export const domainVerificationRequestSchema = z.object({
    domain: z.string().trim().min(1),
});

export type DomainVerificationRequest = z.infer<typeof domainVerificationRequestSchema>;

/**
 * The instructions the API returns when a domain verification is requested. The
 * caller may prove ownership EITHER by publishing the `dns` TXT record OR by
 * serving the `wellKnown` file; either path then satisfies
 * `POST /identity/domains/:domain/verify`.
 */
export const domainVerificationInstructionsSchema = z.object({
    domain: z.string(),
    token: z.string(),
    dns: z.object({
        name: z.string(),
        value: z.string(),
    }),
    wellKnown: z.object({
        url: z.string(),
        body: z.string(),
    }),
});

export type DomainVerificationInstructions = z.infer<
    typeof domainVerificationInstructionsSchema
>;

/* -------------------------------------------------------------------------- */
/*  Auth methods ↔ verification methods                                       */
/* -------------------------------------------------------------------------- */

/**
 * One linked authentication method. Mirrors a `User.authMethods[]` entry.
 * `verificationMethodId` is present for `identity` methods (a key), linking the
 * auth method to its DID verification-method fragment. For `webauthn` methods
 * `credentialId` identifies the specific passkey (one entry per registered
 * credential) and `name` is its user-facing label; a passkey is NOT a DID
 * verification method, so it carries no `verificationMethodId` (a passkey-only
 * account stays custodial).
 */
export interface AuthMethodEntry {
    type: 'identity' | 'webauthn';
    linkedAt: string | Date;
    verificationMethodId?: string;
    credentialId?: string;
    name?: string;
}

export const authMethodEntrySchema: z.ZodType<AuthMethodEntry> = z.object({
    type: z.enum(['identity', 'webauthn']),
    linkedAt: z.union([z.string(), z.date()]),
    verificationMethodId: z.string().optional(),
    credentialId: z.string().optional(),
    name: z.string().optional(),
});

/**
 * Wire shape of `GET /auth/methods` — the account's DID plus every linked
 * authentication method.
 */
export interface AuthMethodsResponse {
    did: string;
    methods: AuthMethodEntry[];
}

export const authMethodsResponseSchema: z.ZodType<AuthMethodsResponse> = z.object({
    did: z.string(),
    methods: z.array(authMethodEntrySchema),
});

/* -------------------------------------------------------------------------- */
/*  Signed data export ("credible exit")                                      */
/* -------------------------------------------------------------------------- */

/**
 * A cryptographic attestation over the canonical-JSON of an export bundle.
 * Reused for both the mandatory Oxy provenance `attestation` (signed with the
 * Oxy custodial key) and the optional client `proof` (signed with the user's
 * own key when they hold one). `signedAt` is epoch milliseconds.
 */
export interface ExportAttestation {
    issuer: string;
    publicKey: string;
    alg: 'ES256K-DER-SHA256';
    signature: string;
    signedAt: number;
}

export const exportAttestationSchema: z.ZodType<ExportAttestation> = z.object({
    issuer: z.string(),
    publicKey: z.string(),
    alg: z.literal('ES256K-DER-SHA256'),
    signature: z.string(),
    signedAt: z.number(),
});

/**
 * One settled charge, as the account it was charged to may take it away.
 *
 * Amounts are EXACT DECIMAL STRINGS, never numbers — the same rule the ledger
 * itself follows. A JSON number cannot represent `0.000000700000` and a bill a
 * customer re-adds must reproduce the figure Oxy charged.
 */
export interface ExportUsageReceipt {
    receiptId: string;
    requestId: string;
    settledAt: string;
    billedAmount: string;
    currency: string;
    outcome: string;
    resolvedModelReference: string;
    servingProvider: string;
    /** True when the charge is Oxy's fee on a BYOK request, not the model cost. */
    platformFeeOnly: boolean;
}

export const exportUsageReceiptSchema: z.ZodType<ExportUsageReceipt> = z.object({
    receiptId: z.string(),
    requestId: z.string(),
    settledAt: z.string(),
    billedAmount: z.string(),
    currency: z.string(),
    outcome: z.string(),
    resolvedModelReference: z.string(),
    servingProvider: z.string(),
    platformFeeOnly: z.boolean(),
});

/** One entry in the account's own journal. */
export interface ExportLedgerEntry {
    entryId: string;
    kind: string;
    currency: string;
    createdAt: string;
}

export const exportLedgerEntrySchema: z.ZodType<ExportLedgerEntry> = z.object({
    entryId: z.string(),
    kind: z.string(),
    currency: z.string(),
    createdAt: z.string(),
});

/** One hold: money that was neither spent nor returned at the time it was taken. */
export interface ExportUsageReservation {
    reservationId: string;
    requestId: string;
    status: string;
    reservedAmount: string;
    currency: string;
    createdAt: string;
    expiresAt: string;
}

export const exportUsageReservationSchema: z.ZodType<ExportUsageReservation> = z.object({
    reservationId: z.string(),
    requestId: z.string(),
    status: z.string(),
    reservedAmount: z.string(),
    currency: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
});

/**
 * What the account was charged, in the subject-access export (#972 section 12).
 *
 * Scoped to the CALLING user's own account and read-only. It exists because a
 * person exercising a subject-access request previously learned nothing about
 * what they had been charged unless they also happened to be an account
 * administrator hitting the enterprise reporting route — the deletion side of
 * that checkbox preserved financial records the export then never disclosed.
 *
 * Empty arrays are the normal answer, and mean the account has no ledger history
 * rather than that anything was withheld.
 */
export interface ExportFinancialSection {
    receipts: ExportUsageReceipt[];
    ledgerEntries: ExportLedgerEntry[];
    reservations: ExportUsageReservation[];
}

export const exportFinancialSectionSchema: z.ZodType<ExportFinancialSection> = z.object({
    receipts: z.array(exportUsageReceiptSchema),
    ledgerEntries: z.array(exportLedgerEntrySchema),
    reservations: z.array(exportUsageReservationSchema),
});

/**
 * The signed, open-format data-export bundle from `GET /users/me/export`. A
 * portable snapshot of the account: its DID document, profile, verified
 * domains, auth methods (no secrets), published signed records, per-app data,
 * social graph, and what the account was charged.
 *
 * `attestation` is the Oxy custodial provenance signature. It is `null` only
 * when the Oxy custodial signing key (`OXY_PRIVATE_KEY`) is unset (dev /
 * pre-prod); in production it is always present. Carries an optional client
 * `proof` when the user signed the bundle with their own key.
 */
export interface ExportBundle {
    '$schema': string;
    exportedAt: string;
    did: string;
    didDocument: DidDocument;
    profile: Record<string, unknown>;
    verifiedDomains: VerifiedDomain[];
    authMethods: AuthMethodEntry[];
    signedRecords: SignedRecordEnvelope[];
    appData: Record<string, unknown>[];
    social: {
        following: string[];
        followers: string[];
    };
    financial: ExportFinancialSection;
    attestation: ExportAttestation | null;
    proof?: ExportAttestation;
}

export const exportBundleSchema: z.ZodType<ExportBundle> = z.object({
    '$schema': z.string(),
    exportedAt: z.string(),
    did: z.string(),
    didDocument: didDocumentSchema,
    profile: z.record(z.unknown()),
    verifiedDomains: z.array(verifiedDomainSchema),
    authMethods: z.array(authMethodEntrySchema),
    signedRecords: z.array(signedRecordEnvelopeSchema),
    appData: z.array(z.record(z.unknown())),
    social: z.object({
        following: z.array(z.string()),
        followers: z.array(z.string()),
    }),
    financial: exportFinancialSectionSchema,
    attestation: exportAttestationSchema.nullable(),
    proof: exportAttestationSchema.optional(),
});
