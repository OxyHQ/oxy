/**
 * The operational catalogue Oxy and Kaana share: deployments, providers and
 * routing profiles. None of it is public: it names who serves a route.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/catalogue.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  cataloguePublisherSummarySchema,
  inferenceDataPolicySchema,
  modelCapabilitiesSchema,
  modelDeprecationSchema,
  modelEvaluationResultSchema,
  modelLicenseSchema,
  modelPowerClassSchema,
  modelProvenanceSchema,
  modelSafetyMetadataSchema,
  powerLevelSchema,
  reasoningEffortSchema,
} from '../public/catalogue.js';
import {
  inferenceDateSchema,
  inferenceHttpsUrlSchema,
  inferenceRegionSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  modelRevisionLabelSchema,
  modelSlugSchema,
  publisherSlugSchema,
  RESERVED_ALIA_PUBLISHER,
  sha256DigestSchema,
} from '../public/identifiers.js';
import { priceSnapshotSchema } from '../public/money.js';
import {
  deploymentIdSchema,
  inferenceProviderSlugSchema,
  routingProfileIdSchema,
  routingProfileSlugSchema,
} from './identifiers.js';
import { scopedExecutionAudienceSchema } from './scopedExecution.js';

/**
 * Who a route may be served to. Availability to an official Oxy product never
 * implies permission to resell the same provider/model publicly, which is why
 * this is an explicit scope on the route rather than a boolean derived from
 * "it works".
 */
export const availabilityScopeSchema = z.enum([
  'platform_internal',
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
        code: 'custom',
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
        code: 'custom',
        path: ['provenance', 'releaseKind'],
        message: `the ${RESERVED_ALIA_PUBLISHER}/* namespace is reserved for first-party releases`,
      });
    }
  });

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
        code: 'custom',
        path: ['reference'],
        message: 'reference must be exactly <modelId>@<revision>',
      });
    }
  });

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
    schemaVersion: z.literal(2),
    deploymentId: deploymentIdSchema,
    /** Restrictive audience; never an eligibility approval. */
    scopedExecution: scopedExecutionAudienceSchema.optional(),
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
        code: 'custom',
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
        code: 'custom',
        path: ['commercialPermission'],
        message: 'a public pay-as-you-go route requires an approved resale permission',
      });
    }

    if (
      deployment.availabilityScope === 'byok_only' &&
      deployment.commercialPermission !== 'customer_byok'
    ) {
      ctx.addIssue({
        code: 'custom',
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
        code: 'custom',
        path: ['priceVersionId'],
        message: 'a BYOK-only route has no customer model price; the platform fee is separate',
      });
    }
  });

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
  /**
   * Present when this profile IS a power level (contract set 3.4.0). Its
   * `candidates` are then the currently servable models of the level's class,
   * and may change between reads; cross-model failover among them is
   * authorized by the profile and reported with a `route_switch` event.
   */
  powerLevel: powerLevelSchema.optional(),
  /**
   * The reasoning effort a power level asks for when the request names none,
   * clamped to the nearest effort the chosen model accepts (the lowest at or
   * above it, else the highest). Absent: the level asks for no reasoning, sent
   * as the least effort a reasoning model accepts.
   */
  reasoningEffort: reasoningEffortSchema.optional(),
});

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
  schemaVersion: z.literal(3),
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
  /**
   * When the upstream provider first published this model, as that provider
   * reports it. Present only when a provider reported it; never an Oxy or Kaana
   * observation time. Lets a picker order models newest first.
   */
  releasedAt: inferenceTimestampSchema.optional(),
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
  /**
   * The reviewed power class this model serves in, when one has been reviewed
   * (contract set 3.4.0). Absent means the model is callable by name only and
   * no power level chooses it.
   */
  powerClass: modelPowerClassSchema.optional(),
});

export type AvailabilityScope = z.infer<typeof availabilityScopeSchema>;
export type CommercialPermission = z.infer<typeof commercialPermissionSchema>;
export type ModelPublisher = z.infer<typeof modelPublisherSchema>;
export type CatalogueModel = z.infer<typeof catalogueModelSchema>;
export type ModelRevision = z.infer<typeof modelRevisionSchema>;
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;
export type ModelDeployment = z.infer<typeof modelDeploymentSchema>;
export type RoutingProfileCandidate = z.infer<typeof routingProfileCandidateSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;
export type CatalogueServingProviderSummary = z.infer<typeof catalogueServingProviderSummarySchema>;
export type ModelCatalogueEntry = z.infer<typeof modelCatalogueEntrySchema>;
