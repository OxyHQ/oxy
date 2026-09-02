/**
 * Compatibility gate for the Oxy↔data-plane inference contracts.
 *
 * The data plane and Alia are built in other repositories against these
 * definitions, so this file answers one question: is what they compiled against still what this
 * package emits?
 *
 * Four mechanisms, because any three of them alone would be satisfiable by an
 * empty scan:
 *
 *  1. **A frozen version map**, asserted with EXACT equality. Every versioned
 *     shape and its `schemaVersion` is listed; adding a shape, removing one, or
 *     bumping a version fails here until somebody updates the snapshot on
 *     purpose. A subset check would let a new shape ship unnoticed.
 *  2. **A census over the real directory.** The module list is checked against
 *     `readdirSync` of `src/inference/`, so a NEW FILE cannot hide from the
 *     scan, and every exported object schema in those modules must be either
 *     versioned or on the frozen embedded list — being on neither is a failure,
 *     not a skip.
 *  3. **A frozen list of the exported UNIONS.** The census takes a union branch
 *     and `continue`s before the versioned/embedded split, so until this list
 *     existed a union was the one shape a contract addition could take and be
 *     frozen by nothing at all. The `>= 8` vacuity floor could not catch it
 *     either: a floor that a new shape only ever RAISES is satisfied by
 *     definition.
 *  4. **A round-trip parse per versioned shape**, with a fixture map whose key
 *     set must equal the version map's, so a new shape also cannot ship without
 *     a realistic example proving it parses.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import * as barrel from '../index';
import * as accountBilling from '../inference/accountBilling';
import * as aliaModelRelease from '../inference/aliaModelRelease';
import * as attribution from '../inference/attribution';
import * as catalogue from '../inference/catalogue';
import * as entitlement from '../inference/entitlement';
import * as errors from '../inference/errors';
import * as identifiers from '../inference/identifiers';
import * as modelDocumentation from '../inference/modelDocumentation';
import * as money from '../inference/money';
import * as priceVersion from '../inference/priceVersion';
import * as providerConnection from '../inference/providerConnection';
import * as request from '../inference/request';
import * as routingPolicy from '../inference/routingPolicy';
import * as streamEvents from '../inference/streamEvents';
import * as usage from '../inference/usage';
import * as version from '../inference/version';

/**
 * Every module of the contract, by file name. Checked against the directory
 * listing below — the list is the census's coverage claim, and a claim nobody
 * verifies is how a whole file stays unscanned.
 */
const INFERENCE_MODULES: Record<string, Record<string, unknown>> = {
  accountBilling,
  aliaModelRelease,
  attribution,
  catalogue,
  entitlement,
  errors,
  identifiers,
  modelDocumentation,
  money,
  priceVersion,
  providerConnection,
  request,
  routingPolicy,
  streamEvents,
  usage,
  version,
};

/** Strip the wrappers `.superRefine()`, `.strict()` and `.brand()` leave behind. */
const unwrapSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  let current = schema;
  while (current instanceof z.ZodEffects || current instanceof z.ZodBranded) {
    current = current instanceof z.ZodEffects ? current.innerType() : current.unwrap();
  }
  return current;
};

/** The `schemaVersion` literal of an object schema, or null when it has none. */
const versionOf = (schema: z.ZodTypeAny): number | null => {
  const unwrapped = unwrapSchema(schema);
  if (!(unwrapped instanceof z.ZodObject)) return null;
  const field = (unwrapped.shape as Record<string, z.ZodTypeAny | undefined>).schemaVersion;
  if (field === undefined) return null;
  if (!(field instanceof z.ZodLiteral)) {
    throw new Error('schemaVersion must be a z.literal so the version is part of the parsed data');
  }
  return field.value as number;
};

const censusVersioned: Record<string, number> = {};
const censusVersionedSchemas: Record<string, z.ZodTypeAny> = {};
const censusEmbedded: string[] = [];
const censusUnions: Array<{ name: string; options: z.ZodTypeAny[] }> = [];

for (const module of Object.values(INFERENCE_MODULES)) {
  for (const [name, exported] of Object.entries(module)) {
    if (!(exported instanceof z.ZodType)) continue;

    const unwrapped = unwrapSchema(exported);

    if (unwrapped instanceof z.ZodDiscriminatedUnion || unwrapped instanceof z.ZodUnion) {
      censusUnions.push({ name, options: unwrapped.options as z.ZodTypeAny[] });
      continue;
    }

    if (!(unwrapped instanceof z.ZodObject)) continue;

    const schemaVersion = versionOf(exported);
    if (schemaVersion === null) {
      censusEmbedded.push(name);
    } else {
      censusVersioned[name] = schemaVersion;
      censusVersionedSchemas[name] = exported;
    }
  }
}

/**
 * THE FROZEN SNAPSHOT. This is the map the data plane and Alia compile
 * against.
 *
 * Changing any number here is a wire-compatibility change: it means a consumer
 * pinned to the previous version now reads that message wrongly. Adding a line
 * means a new shape crossed the boundary. Neither should happen without the
 * corresponding change on the consuming side being planned first.
 */
const FROZEN_SCHEMA_VERSIONS: Record<string, number> = {
  // Request envelope
  inferenceRequestSchema: 1,
  // Stream events
  inferenceStreamStartEventSchema: 1,
  inferenceStreamDeltaEventSchema: 1,
  inferenceStreamToolCallEventSchema: 1,
  inferenceStreamUsageEventSchema: 2,
  inferenceStreamRouteSwitchEventSchema: 1,
  inferenceStreamErrorEventSchema: 1,
  inferenceStreamDoneEventSchema: 1,
  // Catalogue: the six distinct objects plus the customer-safe projection
  modelPublisherSchema: 1,
  catalogueModelSchema: 1,
  modelRevisionSchema: 1,
  inferenceProviderSchema: 1,
  modelDeploymentSchema: 1,
  routingProfileSchema: 1,
  modelCatalogueEntrySchema: 2,
  // Routing policy
  routingPolicySchema: 1,
  // Ledger
  priceVersionSchema: 1,
  usageReservationRequestSchema: 1,
  usageReservationSchema: 1,
  normalizedUsageReportSchema: 2,
  usageReceiptSchema: 1,
  usageRefundSchema: 1,
  // BYOK
  providerConnectionSchema: 1,
  // Account billing (ADR 0014)
  billingProfileSchema: 1,
  accountBillingStateSchema: 1,
  billingInvoiceSchema: 1,
  autoRechargeAttemptSchema: 1,
  reconciliationRunSchema: 1,
  reconciliationDiscrepancySchema: 1,
  reconciliationReportSchema: 1,
  // Product entitlements (ADR 0014)
  costCenterSchema: 1,
  costCenterSpendSchema: 1,
  productEntitlementSchema: 1,
  // Alia model release manifest (§12), and the request that ingests one beside
  // Oxy's own GPAI documentation record for the revision it releases
  aliaModelReleaseManifestSchema: 1,
  modelReleaseIngestionRequestSchema: 1,
  modelReleaseIngestionResultSchema: 1,
  // The revision-scoped documentation a downstream developer reads (§12)
  modelDocumentationSchema: 1,
  // Errors
  inferenceErrorSchema: 1,
};

/**
 * Shapes that ride INSIDE a versioned message and inherit its version.
 *
 * Frozen with the same exactness as the version map, and for the same reason:
 * this list is the only place a shape can legitimately be unversioned, so an
 * ever-growing list is the gate switching itself off one line at a time.
 */
const FROZEN_EMBEDDED_SHAPES: string[] = [
  'aliaReleaseArtifactSchema',
  'aliaReleaseSignatureSchema',
  'authenticatedPrincipalSchema',
  'autoRechargeSchema',
  'billingPrincipalSchema',
  'catalogueServingProviderSummarySchema',
  'cataloguePublisherSummarySchema',
  'clientRequestMetadataSchema',
  'inferenceAttributionSchema',
  'inferenceDataPolicySchema',
  'inferenceMessageSchema',
  'inferenceToolCallSchema',
  'modelCapabilitiesSchema',
  'modelDeprecationSchema',
  'modelDownstreamDocumentationSchema',
  'modelEvaluationResultSchema',
  'modelGpaiDocumentationSchema',
  'modelLicenseSchema',
  'modelLineDeclarationSchema',
  'modelProvenanceSchema',
  'modelSafetyMetadataSchema',
  'externalPaymentSchema',
  'moneySchema',
  'payAsYouGoEntitlementSchema',
  'planAllowanceSchema',
  'priceSnapshotSchema',
  'productPlanSchema',
  'providerConnectionValidationSchema',
  'providerErrorPassthroughSchema',
  'routingFallbackPolicySchema',
  'routingPolicyReferenceSchema',
  'routingProfileCandidateSchema',
  'samplingParametersSchema',
  'toolDefinitionSchema',
  'unitPriceSchema',
  'usageQuantitySchema',
];

/**
 * Every exported UNION, frozen with the same exactness as the two lists above.
 *
 * The census classifies a union into neither of them — it takes the union branch
 * and `continue`s before the versioned/embedded split — so before this list a new
 * union was the one shape that could be added to the contract and be covered by
 * nothing. The `>= 8` vacuity floor below could not catch it either: a floor a
 * new shape only ever raises is satisfied by definition.
 *
 * A union carries no `schemaVersion` of its own by design (its OPTIONS do, where
 * they are versioned messages — `inferenceStreamEventSchema` — and the
 * "unregistered versioned option" test is what holds that). What this list adds
 * is that the SET of unions is a decision somebody makes on purpose.
 */
const FROZEN_UNION_SHAPES: string[] = [
  // The routes the control plane authorized, and how each one is authorized
  'authorizedRouteSchema',
  'inferenceContentPartSchema',
  'inferenceContentSourceSchema',
  'inferenceInputSchema',
  'inferenceRouteSwitchDetailSchema',
  'inferenceStreamEventSchema',
  'providerConnectionScopeSchema',
  'responseFormatSchema',
  'routingPolicyScopeSchema',
  'routingTargetSchema',
  'toolChoiceSchema',
  'usageRefundSubjectSchema',
];

/* -------------------------------------------------------------------------- */
/*  Realistic fixtures — one per versioned shape                              */
/* -------------------------------------------------------------------------- */

const ATTRIBUTION = {
  principal: {
    billing: { accountId: 'acc_01H8Z9QK7M' },
    applicationId: 'app_alia_prod',
    credentialId: 'cred_01H8Z9R2VX',
    environment: 'production',
    inferenceScopes: ['inference:invoke', 'inference:usage:read'],
  },
  userId: 'usr_01H8Z9S4KP',
  requestId: 'req_01H8Z9T6NB',
  generationId: 'gen_01H8Z9T6NC',
};

const DATA_POLICY = {
  retainsPayloads: false,
  retentionDays: 0,
  trainsOnCustomerData: false,
  zeroDataRetentionAvailable: true,
  subprocessors: [],
  policyUrl: 'https://example-provider.test/data-policy',
};

const CAPABILITIES = {
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  tools: true,
  parallelToolCalls: true,
  structuredOutput: true,
  jsonMode: true,
  reasoning: true,
  streaming: true,
  promptCaching: true,
  maxContextTokens: 200000,
  maxOutputTokens: 32000,
};

const LICENSE = {
  licenseId: 'LicenseRef-Provider-Commercial',
  displayName: 'Provider commercial terms',
  url: 'https://example-provider.test/terms',
  commercialUseAllowed: true,
  requiresAttribution: false,
};

/**
 * A first-party release's GPAI documentation record.
 *
 * Deliberately the NON-exempt shape — not free-and-open-source, and past
 * Article 51(2)'s 10^25 FLOP threshold — because that is the state in which every
 * conditional field of `modelGpaiDocumentationSchema` is required. A
 * free-and-open-source fixture would parse with five fields missing and prove
 * nothing about them.
 */
const GPAI_DOCUMENTATION = {
  intendedTasks:
    'General-purpose text generation, summarisation and tool-calling, for integration into assistant and agent systems.',
  distributionMethods: ['oxy_api'],
  architecture: 'Decoder-only transformer with sparse mixture-of-experts routing',
  parameterCount: 70_000_000_000,
  trainingDataSummaryUrl: 'https://alia.onl/models/alia-2/training-data-summary',
  copyrightPolicyUrl: 'https://alia.onl/legal/copyright-policy',
  systemicRisk: 'presumed_by_training_compute',
  freeAndOpenSourceRelease: false,
  trainingComputeFlops: '4.2e25',
  trainingTimeHours: 41_600,
  energyConsumptionMwh: 3_820,
  adversarialTestingReportUrl: 'https://alia.onl/models/alia-2/red-team-report',
};

/**
 * The capability sheet a release does not carry, and Oxy therefore states.
 *
 * See `modelLineDeclarationSchema`: a signed manifest has no `maxContextTokens`
 * and no modalities, and those columns are `NOT NULL` on `inference_models`.
 */
const MODEL_LINE = {
  displayName: 'Alia 2',
  description: 'Alia\u2019s second-generation general-purpose model.',
  capabilities: CAPABILITIES,
  knowledgeCutoff: '2026-03-31',
  releasedOn: '2026-08-16',
};

const PRICE_SNAPSHOT = {
  priceVersionId: 'pv_2026_08',
  currency: 'USD',
  unitPrices: [
    { unit: 'input_tokens', amount: '3.00', per: 1000000, currency: 'USD' },
    { unit: 'output_tokens', amount: '15.00', per: 1000000, currency: 'USD' },
  ],
};

/**
 * One signed Alia release manifest, shared by the manifest's own fixture and the
 * ingestion request's.
 *
 * Shared rather than duplicated because the two are the same document: a copy
 * that drifted would let the manifest round-trip while the request that carries
 * it did not, and the failure would name the wrong schema.
 */
const ALIA_RELEASE_MANIFEST = {
  schemaVersion: 1,
  releaseId: 'arel_01H8ZA1000',
  issuedAt: '2026-08-16T12:00:00.000Z',
  revision: {
    schemaVersion: 1,
    revisionId: 'rev_alia_v2_20260801',
    modelId: 'alia/alia-2',
    revision: '2026-08-01',
    reference: 'alia/alia-2@2026-08-01',
    releasedAt: '2026-08-16T12:00:00.000Z',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    modelCardUrl: 'https://alia.onl/models/alia-2/card',
    evaluations: [{ suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' }],
    safety: {
      safetyCardUrl: 'https://alia.onl/models/alia-2/safety',
      contentFilteringDefault: 'strict',
      knownLimitations: ['Weaker on languages outside its training mix.'],
      provenanceMarking: 'c2pa',
    },
  },
  provenance: {
    releaseKind: 'first_party_derived',
    baseModelId: 'meta/llama-3.1-70b',
    trainingOrganization: 'Alia',
  },
  license: {
    licenseId: 'LicenseRef-Alia-Community-1.0',
    displayName: 'Alia community licence 1.0',
    url: 'https://alia.onl/licence',
    commercialUseAllowed: true,
    requiresAttribution: true,
  },
  artifacts: [
    {
      path: 'model-00001-of-00002.safetensors',
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 9_876_543_210,
      mediaType: 'application/octet-stream',
    },
    {
      path: 'tokenizer.json',
      digest: `sha256:${'c'.repeat(64)}`,
      sizeBytes: 1_842_311,
      mediaType: 'application/json',
    },
  ],
  signatures: [
    {
      algorithm: 'ed25519',
      canonicalization: 'jcs',
      keyId: 'alia-release-2026-08',
      signature: 'A'.repeat(86),
      signedAt: '2026-08-16T12:00:05.000Z',
    },
  ],
};

const FIXTURES: Record<string, unknown> = {
  inferenceRequestSchema: {
    schemaVersion: 1,
    attribution: ATTRIBUTION,
    target: { kind: 'model', modelReference: 'anthropic/claude-opus-5' },
    modality: 'text',
    input: {
      format: 'messages',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are terse.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Summarise this invoice.' }] },
      ],
    },
    stream: true,
    maxOutputTokens: 1024,
    sampling: { temperature: 0.2, topP: 0.9, stopSequences: ['\n\n'] },
    tools: [
      {
        type: 'function',
        name: 'lookup_invoice',
        description: 'Fetch an invoice by id',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        strict: true,
      },
    ],
    toolChoice: 'auto',
    responseFormat: { type: 'text' },
    client: {
      apiFormat: 'responses',
      endpoint: '/v1/responses',
      clientRequestId: 'client-7f2',
      receivedAt: '2026-08-15T09:41:00.000Z',
      labels: { team: 'billing' },
    },
    idempotencyKey: 'idem_01H8Z9T6NB',
    routingPolicy: { routingPolicyId: 'rp_alia_prod', policyVersion: 12 },
    // Preference order. The primary, one same-model failover, and one
    // substitution the customer authorized by name.
    authorizedRoutes: [
      {
        substitution: 'same_model',
        deploymentId: 'dep_anthropic_usw2_opus5',
        modelReference: 'anthropic/claude-opus-5@2026-05-01',
        provider: 'anthropic',
        regions: ['us-west-2'],
      },
      {
        substitution: 'same_model',
        deploymentId: 'dep_bedrock_use1_opus5',
        modelReference: 'anthropic/claude-opus-5@2026-05-01',
        provider: 'bedrock',
        regions: ['us-east-1'],
      },
      {
        substitution: 'cross_model',
        deploymentId: 'dep_openai_usw2_gpt5',
        modelReference: 'openai/gpt-5@2026-04-11',
        provider: 'openai',
        regions: ['us-west-2'],
        authorizedByPolicy: true,
      },
    ],
  },

  inferenceStreamStartEventSchema: {
    schemaVersion: 1,
    type: 'start',
    requestId: 'req_01H8Z9T6NB',
    sequence: 0,
    generationId: 'gen_01H8Z9T6NC',
    resolvedModelReference: 'anthropic/claude-opus-5@2026-05-01',
    servingProvider: 'anthropic',
    startedAt: '2026-08-15T09:41:00.120Z',
  },

  inferenceStreamDeltaEventSchema: {
    schemaVersion: 1,
    type: 'delta',
    requestId: 'req_01H8Z9T6NB',
    sequence: 1,
    outputIndex: 0,
    channel: 'output_text',
    text: 'The invoice totals ',
  },

  inferenceStreamToolCallEventSchema: {
    schemaVersion: 1,
    type: 'tool_call',
    requestId: 'req_01H8Z9T6NB',
    sequence: 2,
    toolCallId: 'call_01H8Z9U8QQ',
    name: 'lookup_invoice',
    argumentsDelta: '{"id":"inv_',
    complete: false,
  },

  inferenceStreamUsageEventSchema: {
    schemaVersion: 2,
    type: 'usage',
    requestId: 'req_01H8Z9T6NB',
    sequence: 3,
    deploymentId: 'dep_anthropic_usw2_opus5',
    units: [
      { unit: 'input_tokens', quantity: 812 },
      { unit: 'output_tokens', quantity: 204 },
    ],
    usageSource: 'provider_reported',
  },

  inferenceStreamRouteSwitchEventSchema: {
    schemaVersion: 1,
    type: 'route_switch',
    requestId: 'req_01H8Z9T6NB',
    sequence: 4,
    reason: 'deployment_unavailable',
    detail: {
      scope: 'deployment',
      modelReference: 'anthropic/claude-opus-5@2026-05-01',
      toProvider: 'bedrock',
      toDeploymentId: 'dep_bedrock_use1_opus5',
    },
    occurredAt: '2026-08-15T09:41:01.400Z',
  },

  inferenceStreamErrorEventSchema: {
    schemaVersion: 1,
    type: 'error',
    requestId: 'req_01H8Z9T6NB',
    sequence: 5,
    error: {
      schemaVersion: 1,
      code: 'provider_overloaded',
      message: 'The upstream provider is overloaded.',
      retryable: true,
      requestId: 'req_01H8Z9T6NB',
      retryAfterMs: 1500,
      providerError: {
        provider: 'anthropic',
        status: 529,
        code: 'overloaded_error',
        message: 'Overloaded',
      },
    },
  },

  inferenceStreamDoneEventSchema: {
    schemaVersion: 1,
    type: 'done',
    requestId: 'req_01H8Z9T6NB',
    sequence: 6,
    generationId: 'gen_01H8Z9T6NC',
    finishReason: 'stop',
    receiptId: 'rcpt_01H8Z9V0AA',
    completedAt: '2026-08-15T09:41:02.900Z',
  },

  modelPublisherSchema: {
    schemaVersion: 1,
    publisherId: 'pub_anthropic',
    slug: 'anthropic',
    displayName: 'Anthropic',
    websiteUrl: 'https://www.anthropic.com',
  },

  catalogueModelSchema: {
    schemaVersion: 1,
    modelId: 'anthropic/claude-opus-5',
    publisher: 'anthropic',
    slug: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    capabilities: CAPABILITIES,
    license: LICENSE,
    provenance: { releaseKind: 'third_party_hosted' },
    knowledgeCutoff: '2026-05-01',
    releasedOn: '2026-06-02',
    currentRevision: '2026-05-01',
    deprecation: { status: 'active' },
  },

  modelRevisionSchema: {
    schemaVersion: 1,
    revisionId: 'rev_opus5_20260501',
    modelId: 'anthropic/claude-opus-5',
    revision: '2026-05-01',
    reference: 'anthropic/claude-opus-5@2026-05-01',
    releasedAt: '2026-06-02T00:00:00.000Z',
    modelCardUrl: 'https://www.anthropic.com/model-card',
    evaluations: [
      { suite: 'swe-bench-verified', metric: 'resolved', score: '74.5%' },
    ],
    safety: {
      contentFilteringDefault: 'provider_default',
      knownLimitations: ['May hallucinate citations.'],
      provenanceMarking: 'none',
    },
  },

  inferenceProviderSchema: {
    schemaVersion: 1,
    providerId: 'prv_anthropic',
    slug: 'anthropic',
    displayName: 'Anthropic',
    kind: 'third_party',
    regions: ['us-west-2', 'eu-central-1'],
    dataPolicy: DATA_POLICY,
  },

  modelDeploymentSchema: {
    schemaVersion: 1,
    deploymentId: 'dep_anthropic_usw2_opus5',
    provider: 'anthropic',
    modelReference: 'anthropic/claude-opus-5@2026-05-01',
    regions: ['us-west-2'],
    dataPolicy: DATA_POLICY,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    status: 'active',
    dedicatedCapacity: false,
    priceVersionId: 'pv_2026_08',
  },

  routingProfileSchema: {
    schemaVersion: 1,
    routingProfileId: 'rpf_auto',
    slug: 'auto',
    displayName: 'Auto',
    description: 'Balances price and latency across qualifying routes.',
    optimiseFor: 'balanced',
    candidates: [
      { modelReference: 'anthropic/claude-opus-5', priority: 0 },
      { modelReference: 'openai/gpt-5', priority: 1 },
    ],
    isProductPreset: true,
  },

  modelCatalogueEntrySchema: {
    schemaVersion: 2,
    modelId: 'anthropic/claude-opus-5',
    publisher: {
      slug: 'anthropic',
      displayName: 'Anthropic',
      websiteUrl: 'https://www.anthropic.com',
    },
    displayName: 'Claude Opus 5',
    currentRevision: '2026-05-01',
    availableRevisions: ['2026-05-01'],
    capabilities: CAPABILITIES,
    license: LICENSE,
    provenance: { releaseKind: 'third_party_hosted' },
    knowledgeCutoff: '2026-05-01',
    regions: ['us-west-2', 'eu-central-1'],
    servingProviders: [
      {
        slug: 'anthropic',
        displayName: 'Anthropic',
        regions: ['us-west-2'],
        dataPolicy: DATA_POLICY,
      },
    ],
    dataPolicy: DATA_POLICY,
    pricing: PRICE_SNAPSHOT,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    deprecation: { status: 'active' },
    evaluations: [],
    modelCardUrl: 'https://www.anthropic.com/model-card',
  },

  routingPolicySchema: {
    schemaVersion: 1,
    routingPolicyId: 'rp_alia_prod',
    policyVersion: 12,
    scope: {
      kind: 'application',
      accountId: 'acc_01H8Z9QK7M',
      applicationId: 'app_alia_prod',
    },
    defaultTarget: { kind: 'routing_profile', routingProfile: 'auto' },
    providerAllowlist: ['anthropic', 'openai'],
    providerDenylist: ['some-unreviewed-provider'],
    allowedRegions: ['us-west-2', 'eu-central-1'],
    deniedRegions: [],
    requireZeroDataRetention: true,
    prohibitTrainingOnCustomerData: true,
    maxPricePerUnit: [
      { unit: 'output_tokens', amount: '20.00', per: 1000000, currency: 'USD' },
    ],
    maxPricePerRequest: { amount: '5.000000000000', currency: 'USD' },
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: true,
    fallback: {
      disabled: false,
      sameModelDeployment: true,
      authorizedCrossModel: ['openai/gpt-5'],
    },
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
    updatedAt: '2026-08-14T18:02:00.000Z',
  },

  priceVersionSchema: {
    schemaVersion: 1,
    priceVersionId: 'pv_2026_08',
    status: 'active',
    modelReference: 'anthropic/claude-opus-5@2026-05-01',
    provider: 'anthropic',
    currency: 'USD',
    unitPrices: PRICE_SNAPSHOT.unitPrices,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    supersedesPriceVersionId: 'pv_2026_05',
    createdAt: '2026-07-28T11:00:00.000Z',
  },

  usageReservationRequestSchema: {
    schemaVersion: 1,
    idempotencyKey: 'idem_01H8Z9T6NB',
    attribution: ATTRIBUTION,
    knownUnits: [{ unit: 'input_tokens', quantity: 812 }],
    maxOutputTokens: 1024,
    ceilingPriceVersionId: 'pv_2026_08',
    maxAmount: '0.024360000000',
    currency: 'USD',
    expiresInSeconds: 900,
  },

  usageReservationSchema: {
    schemaVersion: 1,
    reservationId: 'res_01H8Z9U0ZZ',
    idempotencyKey: 'idem_01H8Z9T6NB',
    attribution: ATTRIBUTION,
    status: 'settled',
    reservedAmount: '0.024360000000',
    currency: 'USD',
    ceilingPriceVersionId: 'pv_2026_08',
    createdAt: '2026-08-15T09:41:00.010Z',
    expiresAt: '2026-08-15T09:56:00.010Z',
    settledReceiptId: 'rcpt_01H8Z9V0AA',
  },

  normalizedUsageReportSchema: {
    schemaVersion: 2,
    requestId: 'req_01H8Z9T6NB',
    generationId: 'gen_01H8Z9T6NC',
    attribution: ATTRIBUTION,
    outcome: 'completed',
    units: [
      { unit: 'input_tokens', quantity: 812 },
      { unit: 'output_tokens', quantity: 204 },
    ],
    usageSource: 'provider_reported',
    resolvedModelReference: 'anthropic/claude-opus-5@2026-05-01',
    servingProvider: 'anthropic',
    deploymentId: 'dep_anthropic_usw2_opus5',
    routeSwitches: 1,
    startedAt: '2026-08-15T09:41:00.120Z',
    completedAt: '2026-08-15T09:41:02.900Z',
    timeToFirstTokenMs: 380,
  },

  usageReceiptSchema: {
    schemaVersion: 1,
    receiptId: 'rcpt_01H8Z9V0AA',
    reservationId: 'res_01H8Z9U0ZZ',
    idempotencyKey: 'idem_01H8Z9T6NB',
    attribution: ATTRIBUTION,
    outcome: 'completed',
    units: [
      { unit: 'input_tokens', quantity: 812 },
      { unit: 'output_tokens', quantity: 204 },
    ],
    usageSource: 'provider_reported',
    priceSnapshot: PRICE_SNAPSHOT,
    billedAmount: '0.005496000000',
    currency: 'USD',
    platformFeeOnly: false,
    resolvedModelReference: 'anthropic/claude-opus-5@2026-05-01',
    servingProvider: 'anthropic',
    settledAt: '2026-08-15T09:41:03.100Z',
  },

  usageRefundSchema: {
    schemaVersion: 1,
    refundId: 'rfnd_01H8Z9V4CC',
    idempotencyKey: 'idem_01H8Z9T6NB:release',
    attribution: ATTRIBUTION,
    subject: { kind: 'reservation', reservationId: 'res_01H8Z9U0ZZ' },
    reason: 'unused_reservation',
    amount: '0.018864000000',
    currency: 'USD',
    createdAt: '2026-08-15T09:41:03.150Z',
  },

  providerConnectionSchema: {
    schemaVersion: 1,
    connectionId: 'pcx_01H8Z9W2DD',
    provider: 'openai',
    ownerAccountId: 'acc_01H8Z9QK7M',
    scope: {
      kind: 'application',
      accountId: 'acc_01H8Z9QK7M',
      applicationId: 'app_alia_prod',
    },
    environment: 'production',
    status: 'active',
    secretRef: 'kms:oxy/inference/byok/production/acc_01H8Z9QK7M/pcx_01H8Z9W2DD',
    keyPrefix: 'sk-proj-4f',
    fingerprint: 'a'.repeat(64),
    validation: { state: 'valid', lastValidatedAt: '2026-08-15T08:00:00.000Z' },
    upstreamBillsCustomerDirectly: true,
    termsAcknowledgedAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
  },

  billingProfileSchema: {
    schemaVersion: 1,
    accountId: 'acc_01H8Z9QK7M',
    currency: 'USD',
    billingMode: 'prepaid',
    status: 'active',
    creditLimit: '0',
    autoRecharge: { enabled: true, threshold: '10.000000000000', amount: '50.000000000000' },
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-15T09:41:03.100Z',
  },

  accountBillingStateSchema: {
    schemaVersion: 1,
    // The project asked about; the organization that actually pays.
    accountId: 'acc_project_codea',
    billingAccountId: 'acc_01H8Z9QK7M',
    inherited: true,
    profile: {
      schemaVersion: 1,
      accountId: 'acc_01H8Z9QK7M',
      currency: 'USD',
      billingMode: 'prepaid',
      status: 'active',
      creditLimit: '0',
      autoRecharge: { enabled: false },
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-15T09:41:03.100Z',
    },
  },

  billingInvoiceSchema: {
    schemaVersion: 1,
    id: 'binv_01H8Z9X5GG',
    accountId: 'acc_01H8Z9QK7M',
    currency: 'USD',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    status: 'open',
    // Exact to full scale; the total is what was actually charged.
    subtotalAmount: '3.703701000000',
    totalAmount: '3.700000000000',
    minorUnitExponent: 2,
    externalInvoiceRef: 'in_1PqRsTuVwXyZ',
    issuedAt: '2026-08-01T00:05:00.000Z',
    receiptCount: 4821,
  },

  autoRechargeAttemptSchema: {
    schemaVersion: 1,
    id: 'arch_01H8Z9X6HH',
    accountId: 'acc_01H8Z9QK7M',
    currency: 'USD',
    requestedAmount: '50.000000000000',
    balanceAtTrigger: '8.220000000000',
    status: 'succeeded',
    externalRef: 'pi_1PqRsTuVwXyZ',
    createdAt: '2026-08-15T09:41:03.100Z',
    updatedAt: '2026-08-15T09:41:04.100Z',
  },

  reconciliationRunSchema: {
    schemaVersion: 1,
    id: 'brun_01H8Z9X7II',
    provider: 'stripe',
    accountId: 'acc_01H8Z9QK7M',
    currency: 'USD',
    periodStart: '2026-08-14T00:00:00.000Z',
    periodEnd: '2026-08-15T00:00:00.000Z',
    status: 'completed',
    ledgerTotal: '412.180000000000',
    externalTotal: '462.180000000000',
    discrepancyCount: 1,
    startedAt: '2026-08-15T01:00:00.000Z',
    completedAt: '2026-08-15T01:00:07.000Z',
  },

  reconciliationDiscrepancySchema: {
    schemaVersion: 1,
    id: 'bdis_01H8Z9X8JJ',
    runId: 'brun_01H8Z9X7II',
    // The one that costs a CUSTOMER: they paid and have no balance.
    kind: 'missing_in_ledger',
    accountId: 'acc_01H8Z9QK7M',
    externalRef: 'pi_1PqRsTuVwXyZ',
    externalAmount: '50.000000000000',
    currency: 'USD',
    createdAt: '2026-08-15T01:00:06.000Z',
  },

  reconciliationReportSchema: {
    schemaVersion: 1,
    run: {
      schemaVersion: 1,
      id: 'brun_01H8Z9X7II',
      provider: 'stripe',
      accountId: 'acc_01H8Z9QK7M',
      currency: 'USD',
      periodStart: '2026-08-14T00:00:00.000Z',
      periodEnd: '2026-08-15T00:00:00.000Z',
      status: 'completed',
      ledgerTotal: '412.180000000000',
      externalTotal: '462.180000000000',
      discrepancyCount: 1,
      startedAt: '2026-08-15T01:00:00.000Z',
      completedAt: '2026-08-15T01:00:07.000Z',
    },
    discrepancies: [
      {
        schemaVersion: 1,
        id: 'bdis_01H8Z9X8JJ',
        runId: 'brun_01H8Z9X7II',
        kind: 'missing_in_ledger',
        accountId: 'acc_01H8Z9QK7M',
        externalRef: 'pi_1PqRsTuVwXyZ',
        externalAmount: '50.000000000000',
        currency: 'USD',
        createdAt: '2026-08-15T01:00:06.000Z',
      },
    ],
  },

  costCenterSchema: {
    schemaVersion: 1,
    accountId: 'acc_project_codea',
    slug: 'codea',
    label: 'Codea',
    status: 'active',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },

  costCenterSpendSchema: {
    schemaVersion: 1,
    costCenter: {
      schemaVersion: 1,
      accountId: 'acc_project_codea',
      slug: 'codea',
      label: 'Codea',
      status: 'active',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    },
    currency: 'USD',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    billedAmount: '412.180000000000',
    requestCount: 4821,
  },

  productEntitlementSchema: {
    schemaVersion: 1,
    accountId: 'acc_01H8Z9QK7M',
    plan: {
      id: 'bsub_01H8Z9X9KK',
      name: 'Pro',
      status: 'active',
      live: true,
      currentPeriodStart: '2026-08-01T00:00:00.000Z',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      allowances: [{ key: 'api_credits_monthly', included: 10000 }],
    },
    // Integer counts. Never in the same field as the exact decimals below.
    allowances: [
      { key: 'api_credits_free', included: 1000, remaining: 640 },
      { key: 'api_credits_monthly', included: 10000 },
    ],
    payAsYouGo: {
      billingAccountId: 'acc_01H8Z9QK7M',
      currency: 'USD',
      billingMode: 'prepaid',
      purchasedBalance: '412.180000000000',
      promotionalBalance: '25.000000000000',
      availableToSpend: '437.180000000000',
      canSpend: true,
    },
    costCenter: null,
    resolvedAt: '2026-08-15T09:41:03.100Z',
  },

  inferenceErrorSchema: {
    schemaVersion: 1,
    code: 'insufficient_balance',
    message: 'The account balance does not cover the maximum cost of this request.',
    retryable: false,
    requestId: 'req_01H8Z9T6NB',
  },

  aliaModelReleaseManifestSchema: ALIA_RELEASE_MANIFEST,

  modelReleaseIngestionRequestSchema: {
    schemaVersion: 1,
    manifest: ALIA_RELEASE_MANIFEST,
    gpaiDocumentation: GPAI_DOCUMENTATION,
    model: MODEL_LINE,
  },

  modelReleaseIngestionResultSchema: {
    schemaVersion: 1,
    releaseId: 'arel_01H8ZA1000',
    modelId: 'alia/alia-2',
    revision: '2026-08-01',
    reference: 'alia/alia-2@2026-08-01',
    outcome: 'ingested',
    artifactCount: 2,
    signatureCount: 1,
    evaluationCount: 1,
    ingestedAt: '2026-08-17T08:15:00.000Z',
  },

  modelDocumentationSchema: {
    schemaVersion: 1,
    modelId: 'alia/alia-2',
    revision: '2026-08-01',
    reference: 'alia/alia-2@2026-08-01',
    isCurrentRevision: true,
    releasedAt: '2026-08-16T12:00:00.000Z',
    modelCardUrl: 'https://alia.onl/models/alia-2/card',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    license: {
      licenseId: 'LicenseRef-Alia-Community-1.0',
      displayName: 'Alia community licence 1.0',
      url: 'https://alia.onl/licence',
      commercialUseAllowed: true,
      requiresAttribution: true,
    },
    provenance: {
      releaseKind: 'first_party_derived',
      baseModelId: 'meta/llama-3.1-70b',
      trainingOrganization: 'Alia',
    },
    evaluations: [{ suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' }],
    safety: {
      safetyCardUrl: 'https://alia.onl/models/alia-2/safety',
      contentFilteringDefault: 'strict',
      knownLimitations: ['Weaker on languages outside its training mix.'],
      provenanceMarking: 'c2pa',
    },
    // The Annex XII half only. Training compute, training time, energy and the
    // adversarial-testing report are Annex XI Section 2 / Article 55(1)(a) and
    // are absent from this projection BY CONSTRUCTION — `.strict()` on
    // `modelDownstreamDocumentationSchema` is what makes that a parse failure
    // rather than a review comment.
    gpai: {
      intendedTasks: GPAI_DOCUMENTATION.intendedTasks,
      distributionMethods: GPAI_DOCUMENTATION.distributionMethods,
      architecture: GPAI_DOCUMENTATION.architecture,
      parameterCount: GPAI_DOCUMENTATION.parameterCount,
      trainingDataSummaryUrl: GPAI_DOCUMENTATION.trainingDataSummaryUrl,
      copyrightPolicyUrl: GPAI_DOCUMENTATION.copyrightPolicyUrl,
      systemicRisk: GPAI_DOCUMENTATION.systemicRisk,
      freeAndOpenSourceRelease: GPAI_DOCUMENTATION.freeAndOpenSourceRelease,
    },
  },
};

/* -------------------------------------------------------------------------- */

describe('inference contract versioning', () => {
  it('exposes the contract-set version the two planes handshake on', () => {
    // MAJOR: terminal reports and partial usage events now require the exact
    // deployment identity and each message moved to schemaVersion 2. A v1
    // producer cannot provide evidence safe enough to settle after failover.
    expect(version.INFERENCE_CONTRACT_VERSION).toBe('2.0.0');
  });

  it('matches the frozen schema version map exactly', () => {
    expect(censusVersioned).toEqual(FROZEN_SCHEMA_VERSIONS);
  });

  it('carries every version in the parsed data, not in a comment', () => {
    for (const [name, expected] of Object.entries(FROZEN_SCHEMA_VERSIONS)) {
      const parsed = censusVersionedSchemas[name].parse(FIXTURES[name]) as {
        schemaVersion: number;
      };
      expect(parsed.schemaVersion).toBe(expected);
    }
  });

  it('rejects a message declaring a version this build does not implement', () => {
    for (const [name, schema] of Object.entries(censusVersionedSchemas)) {
      const bumped = { ...(FIXTURES[name] as Record<string, unknown>), schemaVersion: 99 };
      expect(schema.safeParse(bumped).success).toBe(false);
    }
  });
});

describe('inference contract census', () => {
  it('scans every module in src/inference', () => {
    const files = readdirSync(join(__dirname, '..', 'inference'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.replace(/\.ts$/, ''))
      .sort();

    expect(files).toEqual(Object.keys(INFERENCE_MODULES).sort());
  });

  it('classifies every exported object schema as versioned or embedded', () => {
    expect(censusEmbedded.slice().sort()).toEqual(FROZEN_EMBEDDED_SHAPES.slice().sort());
  });

  it('holds the set of exported unions as an exact equality too', () => {
    // The third classification. Without this, a union is the one shape a new
    // contract addition can take and be frozen by nothing.
    expect(
      censusUnions
        .map((union) => union.name)
        .slice()
        .sort(),
    ).toEqual(FROZEN_UNION_SHAPES.slice().sort());
  });

  it('found the shapes it claims to have scanned', () => {
    // Vacuity floor: a census whose `instanceof` checks silently stopped
    // matching would report an empty world, and every "no unversioned shape
    // found" assertion above would pass for the wrong reason.
    expect(Object.keys(censusVersioned).length).toBeGreaterThanOrEqual(20);
    expect(censusEmbedded.length).toBeGreaterThanOrEqual(20);
    expect(censusUnions.length).toBeGreaterThanOrEqual(8);
  });

  it('holds a realistic fixture for every versioned shape', () => {
    // Compared against what the census FOUND, not against the frozen map, so
    // this fires on a new shape independently of the snapshot being updated.
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(censusVersioned).sort());
  });

  it('round-trips every versioned shape', () => {
    for (const [name, schema] of Object.entries(censusVersionedSchemas)) {
      const parsed = schema.parse(FIXTURES[name]);
      expect(schema.parse(parsed)).toEqual(parsed);
    }
  });

  it('lets no union smuggle in an unregistered versioned option', () => {
    const registered = new Set(Object.values(censusVersionedSchemas));
    for (const union of censusUnions) {
      for (const option of union.options) {
        if (versionOf(option) === null) continue;
        expect(registered.has(option)).toBe(true);
      }
    }
  });

  it('builds the stream union out of exactly the seven exported events', () => {
    const options = streamEvents.inferenceStreamEventSchema.options;
    expect(options).toEqual([
      streamEvents.inferenceStreamStartEventSchema,
      streamEvents.inferenceStreamDeltaEventSchema,
      streamEvents.inferenceStreamToolCallEventSchema,
      streamEvents.inferenceStreamUsageEventSchema,
      streamEvents.inferenceStreamRouteSwitchEventSchema,
      streamEvents.inferenceStreamErrorEventSchema,
      streamEvents.inferenceStreamDoneEventSchema,
    ]);
  });
});

describe('inference contract negative cases', () => {
  it('rejects a floating-point money amount instead of rounding it', () => {
    // ADR 0009: money is an exact decimal, and a JS number cannot be one.
    expect(money.exactDecimalSchema.safeParse(18.06).success).toBe(false);

    const receipt = FIXTURES.usageReceiptSchema as Record<string, unknown>;
    expect(usage.usageReceiptSchema.safeParse({ ...receipt, billedAmount: 18.06 }).success).toBe(
      false,
    );
    expect(
      usage.usageReceiptSchema.safeParse({ ...receipt, billedAmount: '0.0054960000001' }).success,
    ).toBe(false);
  });

  it('rejects a price written as a float or in exponent form', () => {
    expect(money.exactDecimalSchema.safeParse('3.00').success).toBe(true);
    expect(money.exactDecimalSchema.safeParse(3.0).success).toBe(false);
    expect(money.exactDecimalSchema.safeParse('1e-6').success).toBe(false);
  });

  it('refuses a billing principal that carries a delegated user id', () => {
    expect(
      attribution.billingPrincipalSchema.safeParse({
        accountId: 'acc_01H8Z9QK7M',
        userId: 'usr_01H8Z9S4KP',
      }).success,
    ).toBe(false);
  });

  it('refuses a BYOK connection payload carrying credential material', () => {
    const connection = FIXTURES.providerConnectionSchema as Record<string, unknown>;

    expect(
      providerConnection.providerConnectionSchema.safeParse({
        ...connection,
        apiKey: 'sk-live-4f9c2a7b1e6d8f3a5c0b',
      }).success,
    ).toBe(false);

    expect(
      providerConnection.providerConnectionSchema.safeParse({
        ...connection,
        secretRef: 'sk-live-4f9c2a7b1e6d8f3a5c0b',
      }).success,
    ).toBe(false);
  });

  it('refuses a contradictory routing policy', () => {
    const policy = FIXTURES.routingPolicySchema as Record<string, unknown>;

    expect(
      routingPolicy.routingPolicySchema.safeParse({
        ...policy,
        fallback: {
          disabled: true,
          sameModelDeployment: false,
          authorizedCrossModel: ['openai/gpt-5'],
        },
      }).success,
    ).toBe(false);

    expect(
      routingPolicy.routingPolicySchema.safeParse({
        ...policy,
        oxyHostedOnly: true,
        byokPreference: 'require',
      }).success,
    ).toBe(false);

    expect(
      routingPolicy.routingPolicySchema.safeParse({
        ...policy,
        providerAllowlist: ['anthropic'],
        providerDenylist: ['anthropic'],
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown error code', () => {
    const error = FIXTURES.inferenceErrorSchema as Record<string, unknown>;

    expect(errors.inferenceErrorSchema.safeParse({ ...error, code: 'teapot' }).success).toBe(
      false,
    );
    expect(errors.inferenceErrorSchema.safeParse(error).success).toBe(true);
  });

  it('refuses to publish a model catalogue entry through an unversioned parse', () => {
    const entry = FIXTURES.modelCatalogueEntrySchema as Record<string, unknown>;
    const { schemaVersion, ...withoutVersion } = entry;

    expect(schemaVersion).toBe(2);
    expect(catalogue.modelCatalogueEntrySchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('keeps identifiers and references parsing as the grammar documents', () => {
    expect(identifiers.modelReferenceSchema.safeParse('anthropic/claude-opus-5').success).toBe(
      true,
    );
    expect(
      identifiers.modelReferenceSchema.safeParse('anthropic/claude-opus-5@2026-05-01').success,
    ).toBe(true);
    expect(identifiers.modelReferenceSchema.safeParse('claude-opus-5').success).toBe(false);
    // A routing profile can never be written in the shape of a model id.
    expect(identifiers.routingProfileSlugSchema.safeParse('oxy/auto').success).toBe(false);
    expect(identifiers.routingProfileSlugSchema.safeParse('auto').success).toBe(true);
  });

  it('parses the request fixture through the package barrel as well as the module', () => {
    // The barrel is what the data plane and Alia import. A schema that exists
    // in the module and is missing from `src/index.ts` is invisible to every
    // consumer.
    const exported = barrel as unknown as Record<string, unknown>;

    expect(exported.inferenceRequestSchema).toBe(request.inferenceRequestSchema);
    for (const name of Object.keys(FROZEN_SCHEMA_VERSIONS)) {
      expect(exported[name]).toBe(censusVersionedSchemas[name]);
    }
  });
});
