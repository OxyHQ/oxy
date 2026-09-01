/**
 * The model-documentation contracts (#972 §12).
 *
 * Every conditional in `modelGpaiDocumentationSchema` encodes a sentence of
 * Regulation (EU) 2024/1689, so each one is driven from BOTH sides: the state the
 * Act requires a field in, and the state it exempts. A test that only proved the
 * happy path would be satisfied by a schema with no refinement at all.
 *
 * The customer-safe split gets the same treatment. `modelDownstreamDocumentation`
 * is `.strict()` precisely so an Annex XI Section 2 field cannot reach the public
 * projection, and the assertion that matters is the one that FAILS when it does.
 */

import {
  modelDocumentationSchema,
  modelDownstreamDocumentationSchema,
  modelGpaiDocumentationSchema,
  modelReleaseIngestionRequestSchema,
  modelReleaseIngestionResultSchema,
  SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS,
  trainingComputeFlopsSchema,
} from '../index';

/** The non-exempt shape: every conditional field present and required. */
const FULL = {
  intendedTasks: 'Text generation and tool calling for assistant systems.',
  distributionMethods: ['oxy_api'] as const,
  architecture: 'Decoder-only transformer',
  parameterCount: 70_000_000_000,
  trainingDataSummaryUrl: 'https://alia.onl/models/alia-2/training-data-summary',
  copyrightPolicyUrl: 'https://alia.onl/legal/copyright-policy',
  systemicRisk: 'presumed_by_training_compute' as const,
  freeAndOpenSourceRelease: false,
  trainingComputeFlops: '4.2e25',
  trainingTimeHours: 41_600,
  energyConsumptionMwh: 3_820,
  adversarialTestingReportUrl: 'https://alia.onl/models/alia-2/red-team-report',
};

/**
 * The one state Article 53(2) exempts: a free-and-open-source release that is
 * not a model with systemic risk. Carries ONLY the two Article 53(1)(c)/(d)
 * items the exemption does not cover, plus the fields the exemption is assessed
 * against.
 */
const EXEMPT = {
  distributionMethods: ['downloadable_weights'] as const,
  trainingDataSummaryUrl: 'https://alia.onl/models/alia-oss/training-data-summary',
  copyrightPolicyUrl: 'https://alia.onl/legal/copyright-policy',
  systemicRisk: 'not_designated' as const,
  freeAndOpenSourceRelease: true,
};

describe('modelGpaiDocumentationSchema', () => {
  it('accepts a fully documented first-party release', () => {
    expect(modelGpaiDocumentationSchema.parse(FULL).parameterCount).toBe(70_000_000_000);
  });

  it('accepts the Article 53(2) free-and-open-source exemption with the Annex XI set absent', () => {
    const parsed = modelGpaiDocumentationSchema.parse(EXEMPT);
    expect(parsed.architecture).toBeUndefined();
    expect(parsed.energyConsumptionMwh).toBeUndefined();
  });

  it('requires the copyright policy and the training-content summary even when exempt', () => {
    // Article 53(2) exempts points (a) and (b) of 53(1). It does not exempt (c)
    // or (d), and this is the assertion that keeps the exemption from being read
    // as blanket.
    for (const field of ['copyrightPolicyUrl', 'trainingDataSummaryUrl'] as const) {
      const without: Record<string, unknown> = { ...EXEMPT };
      delete without[field];
      expect(modelGpaiDocumentationSchema.safeParse(without).success).toBe(false);
    }
  });

  it('requires each Annex XI field when the exemption does not apply', () => {
    // One removal per field, so a refinement that checked only the first would
    // go red on the rest rather than passing on the strength of one.
    const conditional = [
      'intendedTasks',
      'architecture',
      'parameterCount',
      'trainingTimeHours',
      'energyConsumptionMwh',
    ] as const;

    for (const field of conditional) {
      const without: Record<string, unknown> = { ...FULL };
      delete without[field];
      const result = modelGpaiDocumentationSchema.safeParse(without);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    }
  });

  it('does not exempt a free-and-open-source model that carries systemic risk', () => {
    // Article 53(2)'s own carve-out. Without this the two booleans would let the
    // most heavily regulated case take the lightest documentation.
    expect(
      modelGpaiDocumentationSchema.safeParse({
        ...EXEMPT,
        systemicRisk: 'designated_by_commission',
        adversarialTestingReportUrl: 'https://alia.onl/red-team',
      }).success,
    ).toBe(false);
  });

  it('refuses a systemic-risk presumption that withholds the compute figure', () => {
    const { trainingComputeFlops: _omitted, ...withoutCompute } = FULL;
    const result = modelGpaiDocumentationSchema.safeParse(withoutCompute);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'trainingComputeFlops')).toBe(
        true,
      );
    }
  });

  it('refuses a release whose own compute contradicts its classification', () => {
    // The direction that matters: a figure at or above Article 51(2)'s threshold
    // beside `not_designated`. Both sides of the boundary, so an off-by-one
    // comparison fails rather than passing on the far side of it.
    const belowThreshold = {
      ...FULL,
      systemicRisk: 'not_designated' as const,
      trainingComputeFlops: '9.9e24',
      adversarialTestingReportUrl: undefined,
    };
    expect(modelGpaiDocumentationSchema.safeParse(belowThreshold).success).toBe(true);

    const atThreshold = { ...belowThreshold, trainingComputeFlops: '1e25' };
    const result = modelGpaiDocumentationSchema.safeParse(atThreshold);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'systemicRisk')).toBe(true);
    }

    expect(Number('1e25')).toBe(SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS);
  });

  it('requires the adversarial-testing report of every systemic-risk model', () => {
    // Article 55(1)(a) applies however the classification was acquired, so both
    // non-`not_designated` tiers are driven.
    for (const tier of ['presumed_by_training_compute', 'designated_by_commission'] as const) {
      const { adversarialTestingReportUrl: _omitted, ...without } = FULL;
      const result = modelGpaiDocumentationSchema.safeParse({ ...without, systemicRisk: tier });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path[0] === 'adversarialTestingReportUrl'),
        ).toBe(true);
      }
    }
  });

  it('refuses an unknown field, because a dropped one is a record that says less', () => {
    expect(
      modelGpaiDocumentationSchema.safeParse({ ...FULL, trainingDataProvenance: 'web' }).success,
    ).toBe(false);
  });

  it('refuses a distribution channel that does not exist', () => {
    expect(
      modelGpaiDocumentationSchema.safeParse({ ...FULL, distributionMethods: ['torrent'] }).success,
    ).toBe(false);
    expect(
      modelGpaiDocumentationSchema.safeParse({ ...FULL, distributionMethods: [] }).success,
    ).toBe(false);
  });
});

describe('trainingComputeFlopsSchema', () => {
  it('accepts the spellings a provider publishes', () => {
    for (const value of ['4.2e25', '1e26', '2.5e+26', '42', '0', '9007199254740993']) {
      expect(trainingComputeFlopsSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses a number, so the published figure cannot be rounded on the way in', () => {
    expect(trainingComputeFlopsSchema.safeParse(4.2e25).success).toBe(false);
  });

  it('refuses shapes that are not a figure', () => {
    for (const value of ['4.2E25', '-1e25', '1e', 'e25', '4.2e2.5', '1 e25', '01e25', '']) {
      expect(trainingComputeFlopsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('modelDownstreamDocumentationSchema', () => {
  it('is the Annex XII subset and refuses the Annex XI Section 2 fields', () => {
    // The customer-safe split, enforced by the parse rather than by whoever
    // builds the projection. One field per withheld obligation.
    const withheld = [
      'trainingComputeFlops',
      'trainingTimeHours',
      'energyConsumptionMwh',
      'adversarialTestingReportUrl',
    ] as const;

    for (const field of withheld) {
      expect(
        modelDownstreamDocumentationSchema.safeParse({ ...EXEMPT, [field]: FULL[field] }).success,
      ).toBe(false);
    }

    // Positive control: the same object without them parses, so the four
    // failures above are about those fields and not about the fixture.
    expect(modelDownstreamDocumentationSchema.safeParse(EXEMPT).success).toBe(true);
  });
});

describe('modelReleaseIngestionRequestSchema', () => {
  const MANIFEST = {
    schemaVersion: 1 as const,
    releaseId: 'arel_test',
    issuedAt: '2026-08-16T12:00:00.000Z',
    revision: {
      schemaVersion: 1 as const,
      revisionId: 'rev_alia_2',
      modelId: 'alia/alia-2',
      revision: '2026-08-01',
      reference: 'alia/alia-2@2026-08-01',
      releasedAt: '2026-08-16T12:00:00.000Z',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      modelCardUrl: 'https://alia.onl/models/alia-2/card',
      evaluations: [{ suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' }],
      safety: {
        contentFilteringDefault: 'strict' as const,
        knownLimitations: [],
        provenanceMarking: 'none' as const,
      },
    },
    provenance: { releaseKind: 'first_party_original' as const },
    license: {
      licenseId: 'LicenseRef-Alia-1.0',
      displayName: 'Alia licence',
      commercialUseAllowed: true,
      requiresAttribution: false,
    },
    artifacts: [
      { path: 'model.safetensors', digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 1024 },
    ],
    signatures: [
      {
        algorithm: 'ed25519' as const,
        canonicalization: 'jcs' as const,
        keyId: 'alia-release-2026-08',
        signature: 'A'.repeat(86),
        signedAt: '2026-08-16T12:00:05.000Z',
      },
    ],
  };

  /** The capability sheet a signed manifest does not carry. */
  const MODEL_LINE = {
    displayName: 'Alia 2',
    capabilities: {
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      tools: true,
      parallelToolCalls: false,
      structuredOutput: true,
      jsonMode: true,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
    },
  };

  const REQUEST = {
    schemaVersion: 1 as const,
    manifest: MANIFEST,
    gpaiDocumentation: FULL,
    model: MODEL_LINE,
  };

  it('carries the documentation beside the signed manifest, not inside it', () => {
    const parsed = modelReleaseIngestionRequestSchema.parse(REQUEST);
    expect(parsed.manifest.releaseId).toBe('arel_test');
    expect(parsed.gpaiDocumentation.systemicRisk).toBe('presumed_by_training_compute');
  });

  it('requires the capability sheet the manifest cannot supply', () => {
    // Without it no model line can be created: every `supports_*` flag and both
    // token limits are NOT NULL on `inference_models` and appear nowhere in a
    // signed manifest.
    const { model: _omitted, ...without } = REQUEST;
    expect(modelReleaseIngestionRequestSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a request with no documentation record', () => {
    const { gpaiDocumentation: _omitted, ...without } = REQUEST;
    expect(modelReleaseIngestionRequestSchema.safeParse(without).success).toBe(false);
  });

  it('propagates the refusals of the manifest it composes', () => {
    // Not a re-implementation of the manifest's rules: the point is that
    // composing it did not weaken them, so ONE of them is driven through the
    // wrapper.
    const notFirstParty = {
      ...REQUEST,
      manifest: {
        ...MANIFEST,
        revision: {
          ...MANIFEST.revision,
          modelId: 'meta/llama-3.1-70b',
          reference: 'meta/llama-3.1-70b@2026-08-01',
        },
      },
    };
    expect(modelReleaseIngestionRequestSchema.safeParse(notFirstParty).success).toBe(false);
  });
});

describe('modelReleaseIngestionResultSchema', () => {
  const RESULT = {
    schemaVersion: 1 as const,
    releaseId: 'arel_test',
    modelId: 'alia/alia-2',
    revision: '2026-08-01',
    reference: 'alia/alia-2@2026-08-01',
    outcome: 'ingested' as const,
    artifactCount: 1,
    signatureCount: 1,
    evaluationCount: 1,
    ingestedAt: '2026-08-17T08:15:00.000Z',
  };

  it('reports counts, and reports an idempotent replay as such', () => {
    expect(modelReleaseIngestionResultSchema.parse(RESULT).outcome).toBe('ingested');
    expect(
      modelReleaseIngestionResultSchema.parse({ ...RESULT, outcome: 'already_ingested' }).outcome,
    ).toBe('already_ingested');
  });

  it('refuses a release with no artifact or no signature', () => {
    expect(modelReleaseIngestionResultSchema.safeParse({ ...RESULT, artifactCount: 0 }).success).toBe(
      false,
    );
    expect(
      modelReleaseIngestionResultSchema.safeParse({ ...RESULT, signatureCount: 0 }).success,
    ).toBe(false);
  });

  it('carries no verification finding, because no verifier exists', () => {
    // `.strict()` is what makes this a refusal. A `verified` field would be the
    // signer asserting its own signature, and Oxy has no key to check it with.
    expect(modelReleaseIngestionResultSchema.safeParse({ ...RESULT, verified: true }).success).toBe(
      false,
    );
  });
});

describe('modelDocumentationSchema', () => {
  const DOCUMENTATION = {
    schemaVersion: 1 as const,
    modelId: 'alia/alia-2',
    revision: '2026-08-01',
    reference: 'alia/alia-2@2026-08-01',
    isCurrentRevision: false,
    releasedAt: '2026-08-16T12:00:00.000Z',
    license: {
      licenseId: 'LicenseRef-Alia-1.0',
      displayName: 'Alia licence',
      commercialUseAllowed: true,
      requiresAttribution: false,
    },
    provenance: { releaseKind: 'first_party_original' as const },
    evaluations: [],
  };

  it('documents a revision that is no longer current, which is the point of it', () => {
    const parsed = modelDocumentationSchema.parse({
      ...DOCUMENTATION,
      retiredAt: '2026-09-01T00:00:00.000Z',
    });
    expect(parsed.isCurrentRevision).toBe(false);
    expect(parsed.retiredAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('parses a revision with no documentation record at all', () => {
    // Every revision Oxy did not release is in this state, and it must be a
    // readable one rather than a 500.
    expect(modelDocumentationSchema.parse(DOCUMENTATION).gpai).toBeUndefined();
  });

  it('refuses a reference that does not name its own parts', () => {
    // The pin is the whole value of a revision-scoped view; a reference that
    // resolves elsewhere makes the documentation describe other weights.
    expect(
      modelDocumentationSchema.safeParse({ ...DOCUMENTATION, reference: 'alia/alia-2@2026-01-01' })
        .success,
    ).toBe(false);
  });
});
