/**
 * The canonical model catalogue.
 *
 * Six things are kept DISTINCT here, because collapsing any pair of them is how
 * a catalogue starts lying to customers:
 *
 *  1. **Publisher** — who released the model (`openai`, `meta`, `alia`).
 *  2. **Model** — a long-lived product identity, `<publisher>/<model>`. Its
 *     behaviour changes over time as revisions ship.
 *  3. **Model revision** — an IMMUTABLE point in that history,
 *     `<publisher>/<model>@<revision>`. This is what an evaluation result, a
 *     model card and an artifact digest actually describe.
 *  4. **Inference provider** — who runs the weights (a third party, Oxy's own
 *     hosting, or the customer's own account under BYOK).
 *  5. **Deployment/endpoint** — one concrete servable route: a revision, on a
 *     provider, in a region, under a data policy, with a commercial permission.
 *  6. **Routing profile** — a named strategy for CHOOSING among routes
 *     (`auto`, `fast`, `quality`). A profile is not a model; it has no weights,
 *     no revision and no license, and it is never written in the shape of a
 *     model id.
 *
 * `modelCatalogueEntrySchema` is the customer-safe projection Oxy serves from
 * `GET /v1/models`: it repeats the customer-facing fields rather than embedding
 * the operational descriptors, so internal deployment ids, upstream wholesale
 * costs and route health can never reach it by accident of nesting.
 *
 * Decided in: docs/adr/0008-catalogue-concept-separation.md.
 */

import { z } from 'zod';
import {
  deploymentIdSchema,
  inferenceDateSchema,
  inferenceHttpsUrlSchema,
  inferenceProviderSlugSchema,
  inferenceRegionSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  modelRevisionLabelSchema,
  modelSlugSchema,
  publisherSlugSchema,
  RESERVED_ALIA_PUBLISHER,
  routingProfileIdSchema,
  routingProfileSlugSchema,
  sha256DigestSchema,
} from './identifiers';
import { priceSnapshotSchema } from './priceVersion';

/* -------------------------------------------------------------------------- */
/*  Shared catalogue vocabulary                                               */
/* -------------------------------------------------------------------------- */

/** The modalities a model can consume or produce. */
export const inferenceModalitySchema = z.enum([
  'text',
  'image',
  'audio',
  'video',
  'embedding',
]);

/**
 * What a model can do, in the terms a caller has to decide against before
 * sending a request: can it call tools, does it accept images, will it honour a
 * JSON schema, how much context does it take, how much can it emit.
 */
export const modelCapabilitiesSchema = z
  .object({
    inputModalities: z.array(inferenceModalitySchema).min(1),
    outputModalities: z.array(inferenceModalitySchema).min(1),
    tools: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    jsonMode: z.boolean(),
    reasoning: z.boolean(),
    streaming: z.boolean(),
    promptCaching: z.boolean(),
    maxContextTokens: z.number().int().positive().safe(),
    maxOutputTokens: z.number().int().positive().safe(),
  })
  .strict();

/**
 * License terms, including the two questions that decide whether Oxy may serve
 * a model to third parties at all: is commercial use permitted, and must the
 * base model be attributed.
 */
export const modelLicenseSchema = z
  .object({
    /** SPDX identifier where one exists, otherwise the publisher's own name. */
    licenseId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(200),
    url: inferenceHttpsUrlSchema.optional(),
    commercialUseAllowed: z.boolean(),
    requiresAttribution: z.boolean(),
    acceptableUsePolicyUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/**
 * How a model came to exist.
 *
 * `releaseKind` is what stops `alia/*` from becoming a re-badging namespace:
 * a first-party namespace may only carry models Alia actually trained or
 * derived, never a third-party route wearing an Oxy name.
 */
export const modelProvenanceSchema = z
  .object({
    releaseKind: z.enum([
      'first_party_original',
      'first_party_derived',
      'open_weight',
      'third_party_hosted',
    ]),
    /** The model this one was derived/fine-tuned from, where there is one. */
    baseModelId: modelIdSchema.optional(),
    trainingOrganization: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * What happens to the customer's prompts and responses on a given route.
 *
 * Every field here is enforceable by a routing policy, which is the reason they
 * are structured rather than a prose paragraph on a docs page.
 */
export const inferenceDataPolicySchema = z
  .object({
    retainsPayloads: z.boolean(),
    /** Zero when nothing is retained. */
    retentionDays: z.number().int().nonnegative().max(3650),
    trainsOnCustomerData: z.boolean(),
    zeroDataRetentionAvailable: z.boolean(),
    /** Named subprocessors a payload may pass through, for compliance review. */
    subprocessors: z.array(z.string().min(1).max(200)).default([]),
    policyUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (!policy.retainsPayloads && policy.retentionDays > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retentionDays'],
        message: 'a route that retains no payloads cannot have a retention window',
      });
    }

    // Training requires having the data to train on. A route claiming both is
    // reporting one of the two fields wrongly, and a routing policy that
    // prohibits training would be enforced against a value that is not true.
    if (!policy.retainsPayloads && policy.trainsOnCustomerData) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trainsOnCustomerData'],
        message: 'a route that retains no payloads cannot train on customer data',
      });
    }
  });

/**
 * Who a route may be served to. Availability inside Alia never implies
 * permission to resell the same provider/model publicly, which is why this is
 * an explicit scope on the route rather than a boolean derived from "it works".
 */
export const availabilityScopeSchema = z.enum([
  'internal_alia',
  'public_payg',
  'enterprise',
  'byok_only',
  'oxy_hosted',
]);

/** The commercial basis on which Oxy may serve a route. */
export const commercialPermissionSchema = z.enum([
  'standard_application_use',
  'public_resale_approved',
  'wholesale_contract',
  'customer_byok',
  'open_weight_hosting',
]);

/** Deprecation state, with the replacement a customer should migrate to. */
export const modelDeprecationSchema = z
  .object({
    status: z.enum(['active', 'deprecated', 'retired']),
    replacementModelReference: modelReferenceSchema.optional(),
    announcedAt: inferenceTimestampSchema.optional(),
    sunsetAt: inferenceTimestampSchema.optional(),
  })
  .strict()
  .superRefine((deprecation, ctx) => {
    if (deprecation.status === 'active' && deprecation.sunsetAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sunsetAt'],
        message: 'an active model has no sunset date; announce the deprecation first',
      });
    }
  });

/** One published evaluation result for a revision. */
export const modelEvaluationResultSchema = z
  .object({
    suite: z.string().min(1).max(128),
    metric: z.string().min(1).max(128),
    /** Kept as a string: an eval score is published text, not arithmetic. */
    score: z.string().min(1).max(64),
    evaluatedAt: inferenceTimestampSchema.optional(),
    reportUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/**
 * Safety metadata a downstream developer needs, and the EU AI Act / GPAI
 * documentation trail expects to find beside a served model.
 */
export const modelSafetyMetadataSchema = z
  .object({
    safetyCardUrl: inferenceHttpsUrlSchema.optional(),
    contentFilteringDefault: z.enum(['none', 'provider_default', 'strict']),
    knownLimitations: z.array(z.string().min(1).max(500)).default([]),
    /** Content-provenance marking the modality requires, where it requires one. */
    provenanceMarking: z.enum(['none', 'visible_watermark', 'invisible_watermark', 'c2pa']),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  1. Publisher                                                              */
/* -------------------------------------------------------------------------- */

/** Who released a model. Never a provider, and never a routing profile. */
export const modelPublisherSchema = z.object({
  /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
  schemaVersion: z.literal(1),
  publisherId: z.string().min(1).max(128),
  slug: publisherSlugSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  websiteUrl: inferenceHttpsUrlSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  2. Model                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A model: the long-lived product identity `<publisher>/<model>`.
 *
 * Carries no provider, no region, no price and no availability — those belong
 * to a DEPLOYMENT, because the same model is served on several routes whose
 * answers to those questions differ.
 */
export const catalogueModelSchema = z
  .object({
    /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
    schemaVersion: z.literal(1),
    modelId: modelIdSchema,
    publisher: publisherSlugSchema,
    slug: modelSlugSchema,
    displayName: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    capabilities: modelCapabilitiesSchema,
    license: modelLicenseSchema,
    provenance: modelProvenanceSchema,
    knowledgeCutoff: inferenceDateSchema.optional(),
    releasedOn: inferenceDateSchema.optional(),
    /** The revision served when a caller names the model without pinning one. */
    currentRevision: modelRevisionLabelSchema,
    deprecation: modelDeprecationSchema,
  })
  .superRefine((model, ctx) => {
    if (model.modelId !== `${model.publisher}/${model.slug}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: 'modelId must be exactly <publisher>/<model>',
      });
    }

    // `alia/*` is reserved for models Alia actually owns or derived. A provider
    // alias published under it would make an Oxy-branded model id mean nothing,
    // and would put an Oxy name on somebody else's weights and license.
    if (
      model.publisher === RESERVED_ALIA_PUBLISHER &&
      model.provenance.releaseKind !== 'first_party_original' &&
      model.provenance.releaseKind !== 'first_party_derived'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'releaseKind'],
        message: `the ${RESERVED_ALIA_PUBLISHER}/* namespace is reserved for first-party releases`,
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  3. Model revision                                                         */
/* -------------------------------------------------------------------------- */

/**
 * An immutable revision of a model.
 *
 * `reference` is the exact string a customer pins (`<publisher>/<model>@<revision>`)
 * and is checked against its parts, so a record cannot claim a reference that
 * resolves elsewhere. Evaluation and safety metadata hang here rather than on
 * the model, because they describe specific weights.
 */
export const modelRevisionSchema = z
  .object({
    /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
    schemaVersion: z.literal(1),
    revisionId: z.string().min(1).max(128),
    modelId: modelIdSchema,
    revision: modelRevisionLabelSchema,
    reference: modelReferenceSchema,
    releasedAt: inferenceTimestampSchema,
    retiredAt: inferenceTimestampSchema.optional(),
    /** Digest of the served artifact, where Oxy hosts the weights itself. */
    artifactDigest: sha256DigestSchema.optional(),
    modelCardUrl: inferenceHttpsUrlSchema.optional(),
    evaluations: z.array(modelEvaluationResultSchema).default([]),
    safety: modelSafetyMetadataSchema.optional(),
  })
  .superRefine((revision, ctx) => {
    if (revision.reference !== `${revision.modelId}@${revision.revision}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reference'],
        message: 'reference must be exactly <modelId>@<revision>',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  4. Inference provider                                                     */
/* -------------------------------------------------------------------------- */

/** Who runs the weights for a route. */
export const inferenceProviderSchema = z.object({
  /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
  schemaVersion: z.literal(1),
  providerId: z.string().min(1).max(128),
  slug: inferenceProviderSlugSchema,
  displayName: z.string().min(1).max(200),
  /**
   * `customer_byok` means the customer's own upstream account is billed
   * directly by the provider and Oxy charges only its platform fee.
   */
  kind: z.enum(['third_party', 'oxy_hosted', 'customer_byok']),
  websiteUrl: inferenceHttpsUrlSchema.optional(),
  statusPageUrl: inferenceHttpsUrlSchema.optional(),
  regions: z.array(inferenceRegionSchema).default([]),
  dataPolicy: inferenceDataPolicySchema,
});

/* -------------------------------------------------------------------------- */
/*  5. Deployment / endpoint                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One concrete servable route: a revision, on a provider, with its attested
 * regions, data policy, availability scope and commercial permission.
 *
 * `regions: []` means the provider supplied no location attestation. It never
 * means global availability: Oxy excludes that route whenever a request carries
 * any explicit regional control, while an unconstrained request may still use it.
 *
 * This is the object a routing policy filters and a route switch names — never
 * a model. Two deployments of the SAME revision are what same-model failover
 * moves between; moving to a deployment of a different revision or model is a
 * cross-model fallback and needs explicit authorization.
 */
export const modelDeploymentSchema = z
  .object({
    /** See `version.ts`: exchanged with the data plane on its own. */
    schemaVersion: z.literal(1),
    deploymentId: deploymentIdSchema,
    provider: inferenceProviderSlugSchema,
    /** Always revision-pinned: a deployment serves specific weights. */
    modelReference: modelReferenceSchema,
    regions: z.array(inferenceRegionSchema),
    dataPolicy: inferenceDataPolicySchema,
    availabilityScope: availabilityScopeSchema,
    commercialPermission: commercialPermissionSchema,
    status: z.enum(['active', 'degraded', 'disabled', 'retired']),
    /** Reserved capacity for one enterprise account rather than shared. */
    dedicatedCapacity: z.boolean(),
    /** The price version customers are charged under on this route. */
    priceVersionId: z.string().min(1).max(128).optional(),
  })
  .superRefine((deployment, ctx) => {
    if (!deployment.modelReference.includes('@')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelReference'],
        message: 'a deployment must pin an immutable revision (<publisher>/<model>@<revision>)',
      });
    }

    // A technically callable route is not automatically publicly resellable.
    // Publishing one to pay-as-you-go customers requires a permission state that
    // says somebody reviewed the right to resell it, not merely that it answers.
    if (
      deployment.availabilityScope === 'public_payg' &&
      deployment.commercialPermission !== 'public_resale_approved' &&
      deployment.commercialPermission !== 'wholesale_contract' &&
      deployment.commercialPermission !== 'open_weight_hosting'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commercialPermission'],
        message: 'a public pay-as-you-go route requires an approved resale permission',
      });
    }

    if (
      deployment.availabilityScope === 'byok_only' &&
      deployment.commercialPermission !== 'customer_byok'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commercialPermission'],
        message: 'a BYOK-only route is served under the customer’s own provider terms',
      });
    }

    // This public field is the upstream/model price Oxy charges. A BYOK route
    // bills the customer upstream and keeps that field absent; Oxy's separately
    // reviewed platform-fee version is internal billing configuration and never
    // reuses this provider-price slot.
    if (deployment.priceVersionId !== undefined && deployment.availabilityScope === 'byok_only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priceVersionId'],
        message: 'a BYOK-only route has no customer model price; the platform fee is separate',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  6. Routing profile                                                        */
/* -------------------------------------------------------------------------- */

/** One candidate a profile may resolve to, and how strongly it is preferred. */
export const routingProfileCandidateSchema = z
  .object({
    modelReference: modelReferenceSchema,
    /** Lower sorts first. Ties are broken by the profile's optimisation target. */
    priority: z.number().int().nonnegative().max(1000),
  })
  .strict();

/**
 * A named strategy for choosing among routes — `auto`, `fast`, `quality`.
 *
 * Not a model: it has no publisher, no revision, no license and no weights, and
 * its slug cannot be written as `<publisher>/<model>`. A request that names a
 * profile is asking Oxy to choose; a request that names a model is not, which is
 * the distinction the "never silently substituted" invariant rests on.
 */
export const routingProfileSchema = z.object({
  /** See `version.ts`: served on its own by the catalogue, so it is versioned. */
  schemaVersion: z.literal(1),
  routingProfileId: routingProfileIdSchema,
  slug: routingProfileSlugSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** What the profile optimises for when several candidates qualify. */
  optimiseFor: z.enum(['price', 'latency', 'throughput', 'quality', 'balanced']),
  candidates: z.array(routingProfileCandidateSchema).min(1),
  /** A product preset (Alia's "fast" toggle) rather than a customer's own profile. */
  isProductPreset: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/*  Customer-safe catalogue projection                                        */
/* -------------------------------------------------------------------------- */

/** The publisher fields a customer sees beside a model. */
export const cataloguePublisherSummarySchema = z
  .object({
    slug: publisherSlugSchema,
    displayName: z.string().min(1).max(200),
    websiteUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict();

/**
 * A serving provider as a customer may see it: who ran the request and where.
 *
 * Deliberately has no deployment id, no route id, no health score and no
 * upstream cost — the customer-safe half of the serving boundary, so that
 * exposing attribution can never leak operational topology.
 */
export const catalogueServingProviderSummarySchema = z
  .object({
    slug: inferenceProviderSlugSchema,
    displayName: z.string().min(1).max(200),
    regions: z.array(inferenceRegionSchema).default([]),
    dataPolicy: inferenceDataPolicySchema,
  })
  .strict();

/**
 * One entry of the customer-facing catalogue (`GET /v1/models`).
 *
 * A projection, not a container: it repeats the customer-facing fields instead
 * of embedding the operational descriptors, so no internal identifier can reach
 * a customer by being nested one level deeper than anybody looked.
 */
export const modelCatalogueEntrySchema = z.object({
  /** See `version.ts`: this is the public catalogue response shape. */
  schemaVersion: z.literal(2),
  modelId: modelIdSchema,
  publisher: cataloguePublisherSummarySchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  currentRevision: modelRevisionLabelSchema,
  /** Revisions a customer may pin today, newest first. */
  availableRevisions: z.array(modelRevisionLabelSchema).min(1),
  capabilities: modelCapabilitiesSchema,
  license: modelLicenseSchema,
  provenance: modelProvenanceSchema,
  knowledgeCutoff: inferenceDateSchema.optional(),
  releasedOn: inferenceDateSchema.optional(),
  regions: z.array(inferenceRegionSchema).default([]),
  servingProviders: z.array(catalogueServingProviderSummarySchema).default([]),
  dataPolicy: inferenceDataPolicySchema,
  /** Absent for routes a customer cannot buy per-unit (BYOK-only, internal). */
  pricing: priceSnapshotSchema.optional(),
  /** Present only when every visible deployment shares one scope. */
  availabilityScope: availabilityScopeSchema.optional(),
  /** Present only when every visible deployment shares one permission basis. */
  commercialPermission: commercialPermissionSchema.optional(),
  deprecation: modelDeprecationSchema,
  evaluations: z.array(modelEvaluationResultSchema).default([]),
  safety: modelSafetyMetadataSchema.optional(),
  modelCardUrl: inferenceHttpsUrlSchema.optional(),
});

export type InferenceModality = z.infer<typeof inferenceModalitySchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ModelLicense = z.infer<typeof modelLicenseSchema>;
export type ModelProvenance = z.infer<typeof modelProvenanceSchema>;
export type InferenceDataPolicy = z.infer<typeof inferenceDataPolicySchema>;
export type AvailabilityScope = z.infer<typeof availabilityScopeSchema>;
export type CommercialPermission = z.infer<typeof commercialPermissionSchema>;
export type ModelDeprecation = z.infer<typeof modelDeprecationSchema>;
export type ModelEvaluationResult = z.infer<typeof modelEvaluationResultSchema>;
export type ModelSafetyMetadata = z.infer<typeof modelSafetyMetadataSchema>;
export type ModelPublisher = z.infer<typeof modelPublisherSchema>;
export type CatalogueModel = z.infer<typeof catalogueModelSchema>;
export type ModelRevision = z.infer<typeof modelRevisionSchema>;
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;
export type ModelDeployment = z.infer<typeof modelDeploymentSchema>;
export type RoutingProfileCandidate = z.infer<typeof routingProfileCandidateSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type CataloguePublisherSummary = z.infer<typeof cataloguePublisherSummarySchema>;
export type CatalogueServingProviderSummary = z.infer<
  typeof catalogueServingProviderSummarySchema
>;
export type ModelCatalogueEntry = z.infer<typeof modelCatalogueEntrySchema>;
