import {
  aliaModelReleaseManifestSchema,
  aliaReleaseArtifactSchema,
  aliaReleaseSignatureSchema,
  modelRevisionSchema,
} from '../index';

const WEIGHTS_DIGEST = `sha256:${'b'.repeat(64)}`;
const TOKENIZER_DIGEST = `sha256:${'c'.repeat(64)}`;

const revision = {
  schemaVersion: 1 as const,
  revisionId: 'rev_alia_2_20260801',
  modelId: 'alia/alia-2',
  revision: '2026-08-01',
  reference: 'alia/alia-2@2026-08-01',
  releasedAt: '2026-08-16T12:00:00.000Z',
  artifactDigest: WEIGHTS_DIGEST,
  modelCardUrl: 'https://alia.onl/models/alia-2/card',
  evaluations: [{ suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' }],
  safety: {
    contentFilteringDefault: 'strict' as const,
    knownLimitations: ['Weaker outside its training mix.'],
    provenanceMarking: 'c2pa' as const,
  },
};

const signature = {
  algorithm: 'ed25519' as const,
  canonicalization: 'jcs' as const,
  keyId: 'alia-release-2026-08',
  signature: 'A'.repeat(86),
  signedAt: '2026-08-16T12:00:05.000Z',
};

const manifest = {
  schemaVersion: 1 as const,
  releaseId: 'arel_1',
  issuedAt: '2026-08-16T12:00:00.000Z',
  revision,
  provenance: {
    releaseKind: 'first_party_original' as const,
    trainingOrganization: 'Alia',
  },
  license: {
    licenseId: 'LicenseRef-Alia-Community-1.0',
    displayName: 'Alia community licence 1.0',
    commercialUseAllowed: true,
    requiresAttribution: true,
  },
  artifacts: [
    { path: 'model.safetensors', digest: WEIGHTS_DIGEST, sizeBytes: 9_876_543_210 },
    { path: 'tokenizer.json', digest: TOKENIZER_DIGEST, sizeBytes: 1_842_311 },
  ],
  signatures: [signature],
};

describe('aliaModelReleaseManifestSchema', () => {
  it('parses a signed first-party release', () => {
    const parsed = aliaModelReleaseManifestSchema.parse(manifest);
    expect(parsed.revision.reference).toBe('alia/alia-2@2026-08-01');
    expect(parsed.signatures).toHaveLength(1);
  });

  it('composes the published catalogue shapes rather than restating their fields', () => {
    // The revision inside a manifest is the SAME shape the catalogue serves, so
    // a manifest and the row it produces cannot describe a release differently.
    expect(modelRevisionSchema.parse(revision).reference).toBe(manifest.revision.reference);

    // And it carries its own version, like `billingProfileSchema` inside
    // `accountBillingStateSchema`: two versions of two things, not of one.
    const parsed = aliaModelReleaseManifestSchema.parse(manifest);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.revision.schemaVersion).toBe(1);
  });

  it('refuses an unknown field, because a stripped one breaks the signature', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({ ...manifest, trainingCompute: '4e25' }).success,
    ).toBe(false);

    // Including the field somebody would reach for first: a digest stored beside
    // the document it digests, which would let a verifier check the signature
    // against a claim instead of against the bytes.
    expect(
      aliaModelReleaseManifestSchema.safeParse({ ...manifest, payloadDigest: WEIGHTS_DIGEST })
        .success,
    ).toBe(false);

    // And a verification RESULT, which is Oxy's finding, never the signer's claim.
    expect(
      aliaModelReleaseManifestSchema.safeParse({ ...manifest, verified: true }).success,
    ).toBe(false);
  });

  it('releases only into the reserved alia/* namespace', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        revision: {
          ...revision,
          modelId: 'meta/llama-3.1-70b',
          reference: 'meta/llama-3.1-70b@2026-08-01',
        },
      }).success,
    ).toBe(false);
  });

  it('refuses a re-badged third-party release', () => {
    for (const releaseKind of ['open_weight', 'third_party_hosted']) {
      expect(
        aliaModelReleaseManifestSchema.safeParse({
          ...manifest,
          provenance: { releaseKind },
        }).success,
      ).toBe(false);
    }
  });

  it('makes a derived release name what it derives from', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        provenance: { releaseKind: 'first_party_derived' },
      }).success,
    ).toBe(false);

    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        provenance: { releaseKind: 'first_party_derived', baseModelId: 'meta/llama-3.1-70b' },
      }).success,
    ).toBe(true);
  });

  it('requires the documentation trail a third-party catalogue entry may omit', () => {
    // Each of the four is optional on `modelRevisionSchema` and required here.
    // The revision alone still parses without them, which is what proves the
    // manifest is doing the tightening rather than the catalogue.
    const cases: Array<Record<string, unknown>> = [
      { modelCardUrl: undefined },
      { safety: undefined },
      { evaluations: [] },
      { artifactDigest: undefined },
    ];

    for (const override of cases) {
      const weakened = { ...revision, ...override };
      expect(modelRevisionSchema.safeParse(weakened).success).toBe(true);
      expect(
        aliaModelReleaseManifestSchema.safeParse({ ...manifest, revision: weakened }).success,
      ).toBe(false);
    }
  });

  it('requires the served artifact digest to be one the signature covers', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        revision: { ...revision, artifactDigest: `sha256:${'d'.repeat(64)}` },
      }).success,
    ).toBe(false);

    // Any signed artifact will do — the served one need not be the first.
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        revision: { ...revision, artifactDigest: TOKENIZER_DIGEST },
      }).success,
    ).toBe(true);
  });

  it('refuses a release with no artifacts and no signatures', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({ ...manifest, artifacts: [] }).success,
    ).toBe(false);
    expect(
      aliaModelReleaseManifestSchema.safeParse({ ...manifest, signatures: [] }).success,
    ).toBe(false);
  });

  it('refuses a duplicate artifact path and a duplicate signing key', () => {
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        artifacts: [manifest.artifacts[0], { ...manifest.artifacts[1], path: 'model.safetensors' }],
      }).success,
    ).toBe(false);

    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        signatures: [signature, { ...signature, signedAt: '2026-08-16T12:00:06.000Z' }],
      }).success,
    ).toBe(false);

    // Two DIFFERENT keys co-signing is the case the list exists for.
    expect(
      aliaModelReleaseManifestSchema.safeParse({
        ...manifest,
        signatures: [signature, { ...signature, keyId: 'oxy-attestation-2026-08' }],
      }).success,
    ).toBe(true);
  });
});

describe('aliaReleaseSignatureSchema', () => {
  it('closes the algorithm and the canonicalization', () => {
    expect(aliaReleaseSignatureSchema.parse(signature).algorithm).toBe('ed25519');

    // A verifier that trusts a document's own algorithm name accepts whatever
    // the document nominates.
    expect(aliaReleaseSignatureSchema.safeParse({ ...signature, algorithm: 'none' }).success).toBe(
      false,
    );
    expect(
      aliaReleaseSignatureSchema.safeParse({ ...signature, algorithm: 'hs256' }).success,
    ).toBe(false);

    // A digest over "the manifest" is not verifiable by two implementations that
    // serialize JSON differently, so the scheme is named and closed too.
    expect(
      aliaReleaseSignatureSchema.safeParse({ ...signature, canonicalization: 'whatever' }).success,
    ).toBe(false);
  });

  it('refuses a truncated or non-base64url signature', () => {
    expect(
      aliaReleaseSignatureSchema.safeParse({ ...signature, signature: 'A'.repeat(85) }).success,
    ).toBe(false);
    expect(
      aliaReleaseSignatureSchema.safeParse({ ...signature, signature: `${'A'.repeat(84)}==` })
        .success,
    ).toBe(false);
  });

  it('keeps keyId opaque, so either signing authority fits', () => {
    // The open owner decision: nothing here names the registry that resolves it.
    for (const keyId of ['alia-release-2026-08', 'did:web:alia.onl#release-1', 'oxy-attest-7']) {
      expect(aliaReleaseSignatureSchema.safeParse({ ...signature, keyId }).success).toBe(true);
    }
    expect(aliaReleaseSignatureSchema.safeParse({ ...signature, keyId: '' }).success).toBe(false);
  });
});

describe('aliaReleaseArtifactSchema', () => {
  it('holds one digest spelling, so two records of one artifact compare equal', () => {
    const artifact = { path: 'model.safetensors', digest: WEIGHTS_DIGEST, sizeBytes: 1 };
    expect(aliaReleaseArtifactSchema.parse(artifact).digest).toBe(WEIGHTS_DIGEST);

    for (const digest of [
      `sha256:${'B'.repeat(64)}`,
      'b'.repeat(64),
      `sha512:${'b'.repeat(64)}`,
      `sha256:${'b'.repeat(63)}`,
    ]) {
      expect(aliaReleaseArtifactSchema.safeParse({ ...artifact, digest }).success).toBe(false);
    }
  });

  it('requires a size beside the digest', () => {
    expect(
      aliaReleaseArtifactSchema.safeParse({ path: 'model.safetensors', digest: WEIGHTS_DIGEST })
        .success,
    ).toBe(false);
    expect(
      aliaReleaseArtifactSchema.safeParse({
        path: 'model.safetensors',
        digest: WEIGHTS_DIGEST,
        sizeBytes: 0,
      }).success,
    ).toBe(false);
  });
});
