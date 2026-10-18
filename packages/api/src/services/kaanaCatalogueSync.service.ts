/**
 * The automatic Kaana → Oxy model catalogue sync.
 *
 * **Feeds the old edge only (`api.oxy.so/v1` and its `/v1/models`) and ends with
 * it.** The model catalogue is Kaana's (Kaana ADR 0002, amendment 2026-10-15);
 * grants for `kaana.ai/v1` are rated from the `declaredCatalogue` Kaana relays
 * (`kaanaDeclaredCatalogue.service.ts`) and never from the tables this job
 * fills. Phase 5 deletes this job; until then it is not extended, it gains no
 * reverse direction, and nothing new reads its output for price or identity.
 *
 * Owner direction (2026-09-25): Kaana discovers hundreds of real models, and
 * official Oxy products (Alia first) must be able to list and call ALL of them
 * by model id. Nothing hand-curated sits in between. So this job reads Kaana's
 * signed `GET /internal/v1/models`, and for every model line it can describe
 * without inventing a fact it writes the model, its current revision, one
 * deployment per exact Kaana route, a price version from the provider's list
 * price and a price-only routing scorecard. Every route it writes is approved
 * automatically for `platform_internal` use under the `kaana-sync` policy
 * record, and nothing wider: public resale keeps its reviewed process.
 *
 * ## What it never does
 *
 * - **Invent a required fact.** A model with no context window, no maximum
 *   output, no modalities or no list price for a route is SKIPPED and counted,
 *   not filled with a plausible number. A route on a provider Oxy has no
 *   reviewed data-policy row for is skipped the same way.
 * - **Touch a reviewed row.** Rows authored by the reviewed bootstrap or staff
 *   tooling (`catalogue_source = 'reviewed'`, `auto_approval_policy_id IS
 *   NULL`) keep every reviewed fact. The one exception is `reasoning_efforts`
 *   (and the provider's release date), which is a serving capability Kaana
 *   owns, not a legal fact.
 * - **Invent media-output safety metadata.** A model producing images, audio, video or
 *   embeddings must declare a content-provenance marking (migration 0050), and
 *   Kaana does not report one. Such lines are skipped; the reviewed speech route
 *   stays reviewed. Exact private decisions-only contracts may import actual
 *   decisions output without claiming a media marking or a public offer.
 * - **Serve `alia/*`.** That namespace is reserved for first-party releases.
 *
 * ## Retirement
 *
 * A synced deployment Kaana no longer reports is retired (`status` and
 * `permission_state` both `retired`), which removes it from every catalogue
 * read and every route resolution in the same commit. A report that would
 * retire more than half of the synced routes at once is treated as a broken
 * report rather than a mass retirement, unless an operator passes
 * `allowMassRetirement` through the admin trigger.
 *
 * ## Legal-review fields
 *
 * `inference_models` requires licence and provenance columns Kaana cannot
 * know. Synced rows record them conservatively and say so rather than claim
 * a review: {@link SYNCED_LICENSE}. See docs/inference/catalogue.md.
 */

import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  deploymentIdSchema,
  inferenceProviderSlugSchema,
  modelIdSchema,
  modelReferenceSchema,
} from '@oxy.so/contracts';
import { getDb, type Transaction } from '../config/postgres';
import {
  canonicalAcceptedParameters,
  DEPLOYMENT_REQUEST_PARAMETERS,
  INFERENCE_MODALITIES,
  INFERENCE_OUTPUT_MODALITIES,
  KAANA_SYNC_AUTO_APPROVAL_POLICY_ID,
  LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE,
  MODEL_REASONING_EFFORTS,
  RESERVED_FIRST_PARTY_PUBLISHER,
  TOOL_CHOICE_VALUE_PARAMETERS,
  inferenceCatalogueAutoApprovalPolicies,
  inferenceCatalogueBlocklist,
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersionUnitPrices,
  priceVersions,
  type DeploymentRequestParameter,
  type InferenceModalityValue,
  type InferenceOutputModalityValue,
} from '../db/schema';
import { logger } from '../utils/logger';
import { type PeriodicJob, schedulePeriodicJob } from '../utils/periodicJobs';
import {
  indexReviewedProviderRoutes,
  reviewedRouteKey,
  type ReviewedProviderRoute,
  type ReviewedProviderRouteIndex,
} from '../config/kaanaReviewedProviderRoutes';
import {
  createHttpKaanaCatalogueReader,
  type KaanaCatalogueReader,
  kaanaDeploymentCommercialSchema,
} from './httpKaanaClient';
import type { KaanaDeploymentAttestation } from './kaanaClient';
import {
  createHttpKaanaCredentialEconomicsReader,
  fundingEvidenceByProvider,
  fundingNeedsRenewal,
  type CredentialEconomicsReader,
  type ProviderFundingEvidence,
  type ProviderFundingIndex,
} from './kaanaCredentialEconomics.service';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** How often the fleet re-reads Kaana. Every task registers; one runs. */
export const KAANA_CATALOGUE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** The first run after boot, so a fresh deploy converges without waiting. */
const KAANA_CATALOGUE_SYNC_FIRST_RUN_DELAY_MS = 60 * 1000;
const KAANA_CATALOGUE_FETCH_TIMEOUT_MS = 60 * 1000;
const SYNC_LOCK_NAMESPACE = 'oxy-kaana-catalogue-sync-v1';
/** A report retiring more than this share of synced routes is presumed broken. */
export const MAX_ROUTINE_RETIREMENT_FRACTION = 0.5;
/** The `changed_by_user_id` a synced scorecard carries: a system actor, not a person. */
export const KAANA_SYNC_ACTOR = 'system:kaana-sync';
const LEGAL_EVIDENCE_REF = `auto-approval-policy:${KAANA_SYNC_AUTO_APPROVAL_POLICY_ID}`;
const PERMISSION_NOTE =
  'Approved automatically by the kaana-sync policy for platform_internal use (official Oxy products). Not approved for public resale.';
const RETIRED_NOTE = 'Retired by the kaana-sync: Kaana no longer reports this exact deployment.';
const BLOCKED_NOTE = 'Retired by the catalogue blocklist.';
const MAX_REPORTED_SKIPS = 200;
/** Kaana's `/internal/v1/deployments/query` accepts at most 64 exact ids. */
const KAANA_ATTESTATION_BATCH = 64;

/**
 * The licence/provenance columns a synced model carries. Nothing here is a
 * review result, and each value is the conservative reading:
 *
 * - `licenseId` is an SPDX `LicenseRef-` naming "the serving provider's terms",
 *   because what governs Oxy's use of a hosted model is the provider agreement,
 *   and the weights' own licence was not reviewed.
 * - `commercialUseAllowed: false` — NOT asserted. A routing policy with
 *   `requireCommercialUseRights` therefore excludes synced routes, which is the
 *   direction a missing review must fail in.
 * - `requiresAttribution: true` — assumed until reviewed.
 * - `releaseKind: 'third_party_hosted'` — every synced route is served by a
 *   third-party provider; open-weight status is not asserted.
 */
export const SYNCED_LICENSE = {
  licenseId: 'LicenseRef-Oxy-Serving-Provider-Terms',
  licenseDisplayName: "Serving provider's terms (not individually reviewed)",
  commercialUseAllowed: false,
  requiresAttribution: true,
  releaseKind: 'third_party_hosted',
} as const;

/* -------------------------------------------------------------------------- */
/*  Parsing Kaana's catalogue                                                  */
/* -------------------------------------------------------------------------- */

export type ModelSkipReason =
  | 'invalid_entry'
  | 'blocked'
  | 'reserved_namespace'
  | 'missing_context_tokens'
  | 'missing_max_output_tokens'
  | 'missing_modalities'
  | 'non_text_output_unreviewed'
  | 'no_priced_route';

export type DeploymentSkipReason =
  | 'invalid_descriptor'
  | 'unattested_route'
  | 'unknown_provider'
  | 'invalid_list_price'
  | 'duplicate_route'
  | 'reviewed_deployment';

/** A provider's list price in USD per 1M tokens, as exact decimals. */
export interface KaanaListPrice {
  readonly input: string;
  readonly output: string;
  /**
   * A prompt-cache read, when the provider publishes a price for one. Kaana's
   * `listPrices` never carries it; a reviewed provider route does
   * (`config/kaanaReviewedProviderRoutes.ts`). Absent means the input rate.
   */
  readonly cachedInput?: string;
}

/**
 * One exact deployment as Kaana ATTESTED it through the signed
 * `POST /internal/v1/deployments/query` — the same evidence the edge's
 * preflight checks before every request, so the region set Oxy stores is the
 * one it will later sign and Kaana will later compare.
 */
export interface KaanaDeploymentDescriptor {
  readonly deploymentId: string;
  readonly provider: string;
  readonly modelReference: string;
  readonly regions: readonly string[];
  /** This deployment's own accepted request controls, when Kaana reports them. */
  readonly acceptedParameters?: readonly string[];
}

/** One `listPrices` observation: a provider's published price for one exact deployment. */
export interface KaanaPricedRoute {
  readonly deploymentId: string;
  readonly provider: string;
  readonly price: KaanaListPrice | 'invalid';
  /**
   * Where the price came from when it is NOT Kaana's list price: the reviewed
   * provider documentation it was read from. Absent for a Kaana observation.
   */
  readonly priceEvidenceRef?: string;
}

/** One model line exactly as Kaana reported it, after shape validation only. */
export interface KaanaCatalogueModel {
  readonly model: string;
  readonly modelReference: string;
  readonly displayName?: string;
  readonly createdAt?: string;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly supportsTools?: boolean;
  readonly reasoningEfforts?: readonly string[];
  /**
   * The request controls every REPORTING deployment of the line accepts (the
   * intersection). Absent means no deployment said.
   */
  readonly acceptedParameters?: readonly string[];
  /** The distinct providers serving the line's current revision. */
  readonly providers?: readonly string[];
  /** Kaana's `listPrices`: only deployments whose provider publishes a price. */
  readonly listPrices: readonly KaanaPricedRoute[];
  /** `listPrices` rows whose shape could not be read. */
  readonly invalidDeployments: number;
}

export interface ParsedKaanaCatalogue {
  readonly snapshotId?: string;
  readonly checkedAt?: string;
  readonly models: readonly KaanaCatalogueModel[];
  readonly invalidEntries: number;
}

const nullish = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const kaanaCatalogueResponseSchema = z
  .object({
    checkedAt: nullish(z.string().max(64)),
    configuration: nullish(
      z.object({ snapshotId: nullish(z.string().min(1).max(256)) }).passthrough(),
    ),
    models: z.array(z.unknown()),
    scopedExecutionContractVersion: z.literal('3.6.0').optional(),
    deployments: z
      .array(
        z
          .object({
            deploymentId: deploymentIdSchema,
            modelReference: modelReferenceSchema,
            provider: inferenceProviderSlugSchema,
            regions: z.array(z.string()),
            // A restricted (scoped) publication, listed by the negotiated read
            // Kaana still requires. Never imported: see `parseKaanaCatalogue`.
            scopedExecution: z.unknown().optional(),
            privateAutoSourceApproval: z.unknown().optional(),
            keyId: z.string().optional(),
            upstreamModelId: z.string().optional(),
            providerRateCardVersionId: z.string().optional(),
            providerSourceVersion: z.string().optional(),
            acceptedParameters: z.array(z.string()).optional(),
            // How the route may be sold: @kaana.ai/contracts
            // `deploymentCommercialSchema`, the one validator Oxy applies to it
            // (httpKaanaClient). Kaana publishes it on every descriptor (#178).
            commercial: kaanaDeploymentCommercialSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .passthrough();

const kaanaListPriceSchema = z
  .object({
    deploymentId: deploymentIdSchema,
    provider: inferenceProviderSlugSchema,
    currency: z.string(),
    input: z.unknown(),
    output: z.unknown(),
  })
  .passthrough();

const kaanaCatalogueEntrySchema = z
  .object({
    model: modelIdSchema,
    modelReference: modelReferenceSchema,
    displayName: nullish(z.string().trim().min(1).max(200)),
    createdAt: nullish(z.string().datetime({ offset: true })),
    contextTokens: nullish(z.number().int().positive().max(2_147_483_647)),
    maxOutputTokens: nullish(z.number().int().positive().max(2_147_483_647)),
    inputModalities: nullish(z.array(z.string())),
    outputModalities: nullish(z.array(z.string())),
    supportsTools: nullish(z.boolean()),
    reasoningEfforts: nullish(z.array(z.string())),
    acceptedParameters: nullish(z.array(z.string())),
    providers: nullish(z.array(z.string())),
    listPrices: nullish(z.array(z.unknown())),
  })
  .passthrough();

/** An exact non-negative decimal with at most 12 fraction digits, or `undefined`. */
export function normalizeDecimal(value: unknown): string | undefined {
  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : undefined;
  if (text === undefined || !/^\d+(\.\d{1,12})?$/.test(text)) return undefined;
  const [whole, fraction] = text.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  const trimmedFraction = (fraction ?? '').replace(/0+$/, '');
  return trimmedFraction.length === 0 ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
}

function parsePricedRoute(raw: unknown): KaanaPricedRoute | undefined {
  const row = kaanaListPriceSchema.safeParse(raw);
  if (!row.success) return undefined;
  const input = normalizeDecimal(row.data.input);
  const output = normalizeDecimal(row.data.output);
  return {
    deploymentId: row.data.deploymentId,
    provider: row.data.provider,
    // Oxy's price versions here are USD; another currency is not converted.
    price:
      row.data.currency !== 'USD' || input === undefined || output === undefined
        ? 'invalid'
        : { input, output },
  };
}

/**
 * Read Kaana's catalogue body into model lines. Shape errors in ONE entry skip
 * that entry; a body that is not a catalogue at all throws, because an empty
 * parse would otherwise read as "Kaana serves nothing" and retire everything.
 */
export function parseKaanaCatalogue(payload: unknown): ParsedKaanaCatalogue {
  const response = kaanaCatalogueResponseSchema.safeParse(payload);
  if (!response.success) {
    // Name what failed: the old fixed "no models array" hid that a single
    // unknown descriptor member rejects the whole body (2026-10-15 outage).
    const issue = response.error.issues[0];
    throw new Error(
      `Kaana returned a catalogue body Oxy cannot read (${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'})`,
    );
  }
  if (
    response.data.scopedExecutionContractVersion !== undefined &&
    response.data.deployments === undefined
  ) {
    throw new Error('Negotiated catalogue must declare exact deployment audiences.');
  }
  const deploymentAudience = new Map<
    string,
    NonNullable<typeof response.data.deployments>[number]
  >();
  for (const descriptor of response.data.deployments ?? []) {
    if (deploymentAudience.has(descriptor.deploymentId))
      throw new Error('Duplicate catalogue deployment identity.');
    deploymentAudience.set(descriptor.deploymentId, descriptor);
  }
  let invalidEntries = 0;
  const models: KaanaCatalogueModel[] = [];
  for (const rawEntry of response.data.models) {
    const entry = kaanaCatalogueEntrySchema.safeParse(rawEntry);
    if (!entry.success) {
      invalidEntries += 1;
      continue;
    }
    const data = entry.data;
    const listPrices: KaanaPricedRoute[] = [];
    let invalidDeployments = 0;
    for (const rawPrice of data.listPrices ?? []) {
      const priced = parsePricedRoute(rawPrice);
      const descriptor =
        priced === undefined ? undefined : deploymentAudience.get(priced.deploymentId);
      if (
        response.data.scopedExecutionContractVersion !== undefined &&
        (descriptor === undefined ||
          descriptor.modelReference !== data.modelReference ||
          descriptor.provider !== priced?.provider)
      ) {
        invalidDeployments += 1;
        continue;
      }
      // A scoped or Private Auto publication is a retired source approval
      // (decisions are served by `kaana.ai/v1`): never priced, attested or stored.
      if (
        descriptor?.scopedExecution !== undefined ||
        descriptor?.privateAutoSourceApproval !== undefined
      ) {
        continue;
      }
      if (priced === undefined) invalidDeployments += 1;
      else listPrices.push(priced);
    }
    models.push({
      model: data.model,
      modelReference: data.modelReference,
      displayName: data.displayName,
      createdAt: data.createdAt,
      contextTokens: data.contextTokens,
      maxOutputTokens: data.maxOutputTokens,
      inputModalities: data.inputModalities,
      outputModalities: data.outputModalities,
      supportsTools: data.supportsTools,
      reasoningEfforts: data.reasoningEfforts,
      acceptedParameters: data.acceptedParameters,
      providers: data.providers,
      listPrices,
      invalidDeployments,
    });
  }
  return {
    snapshotId: response.data.configuration?.snapshotId,
    checkedAt: response.data.checkedAt,
    models,
    invalidEntries,
  };
}

/* -------------------------------------------------------------------------- */
/*  Planning one model line (pure)                                            */
/* -------------------------------------------------------------------------- */

export interface PlannedRoute {
  readonly deploymentId: string;
  readonly provider: string;
  readonly regions: readonly string[];
  readonly price: KaanaListPrice;
  /** The reviewed source of `price`, when it is not Kaana's list price. */
  readonly priceEvidenceRef?: string;
  /** `inference_deployments.accepted_parameters`; `null` is unknown. */
  readonly acceptedParameters: readonly DeploymentRequestParameter[] | null;
}

export interface PlannedModel {
  readonly modelId: string;
  readonly publisher: string;
  readonly slug: string;
  readonly revision: string;
  readonly modelReference: string;
  readonly displayName: string;
  readonly providerReleasedAt: Date | null;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly inputModalities: readonly InferenceModalityValue[];
  readonly outputModalities: readonly InferenceOutputModalityValue[];
  readonly supportsTools: boolean;
  readonly reasoningEfforts: readonly (typeof MODEL_REASONING_EFFORTS)[number][];
  readonly routes: readonly PlannedRoute[];
  readonly routeSkips: readonly DeploymentSkipReason[];
}

export type ModelPlan =
  | { readonly status: 'planned'; readonly model: PlannedModel }
  | {
      readonly status: 'skipped';
      readonly reason: ModelSkipReason;
      readonly routeSkips?: readonly DeploymentSkipReason[];
    };

const KNOWN_MODALITIES: ReadonlySet<string> = new Set(INFERENCE_MODALITIES);
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS);

const KNOWN_REQUEST_PARAMETERS: ReadonlySet<string> = new Set(DEPLOYMENT_REQUEST_PARAMETERS);

/**
 * A reported accepted-parameter set in Oxy's vocabulary and order. `undefined`
 * (nobody said) stays `null`, never `[]`. A word Oxy does not know is dropped:
 * the edge never checks a control outside its vocabulary, so dropping one
 * cannot make a route refuse anything.
 */
export function normalizeAcceptedParameters(
  values: readonly string[] | undefined,
): DeploymentRequestParameter[] | null {
  if (values === undefined) return null;
  const reported = new Set(values.filter((value) => KNOWN_REQUEST_PARAMETERS.has(value)));
  return DEPLOYMENT_REQUEST_PARAMETERS.filter((parameter) => reported.has(parameter));
}

/**
 * Which accepted-parameter set one exact route is stored with.
 *
 * Per-deployment evidence from Kaana's signed descriptor wins. Otherwise the
 * catalogue entry's set is an INTERSECTION over the line's reporting
 * deployments, which proves what every reporter accepts but not what any one
 * of them refuses; it describes a single route only when every deployment of
 * the line is on one provider, whose one statement about the model is what
 * each of them reported. Anything else is unknown, and unknown filters
 * nothing: a wrong narrowing would refuse a request Kaana could serve.
 */
function acceptedParametersForRoute(
  entry: KaanaCatalogueModel,
  deployment: KaanaDeploymentDescriptor,
): DeploymentRequestParameter[] | null {
  if (deployment.acceptedParameters !== undefined) {
    return normalizeAcceptedParameters(deployment.acceptedParameters);
  }
  const providers = new Set(entry.providers ?? []);
  if (providers.size !== 1 || !providers.has(deployment.provider)) return null;
  return normalizeAcceptedParameters(entry.acceptedParameters);
}

/**
 * Two statements about one route, combined: a control is accepted only when
 * every statement that SAID something accepts it. `null` (nobody said) abstains,
 * exactly as Kaana combines a line's reports (`provider.IntersectParameterSets`);
 * two `null`s stay unknown. Both are read canonically, and the `toolChoice`
 * field is dropped when no tool-choice value survives, so the stored set can
 * never be re-read as "every value".
 */
export function intersectAcceptedParameters(
  first: readonly DeploymentRequestParameter[] | null,
  second: readonly DeploymentRequestParameter[] | null,
): DeploymentRequestParameter[] | null {
  if (first === null && second === null) return null;
  const statements = [first, second].filter(
    (statement): statement is readonly DeploymentRequestParameter[] => statement !== null,
  );
  const canonical = statements.map((statement) => canonicalAcceptedParameters(statement));
  const accepted = DEPLOYMENT_REQUEST_PARAMETERS.filter((parameter) =>
    canonical.every((statement) => statement.includes(parameter)),
  );
  const anyValue = accepted.some((parameter) =>
    (TOOL_CHOICE_VALUE_PARAMETERS as readonly string[]).includes(parameter),
  );
  return anyValue ? accepted : accepted.filter((parameter) => parameter !== 'toolChoice');
}

function knownModalities(values: readonly string[] | undefined): InferenceModalityValue[] {
  return [
    ...new Set((values ?? []).filter((value) => KNOWN_MODALITIES.has(value))),
  ].sort() as InferenceModalityValue[];
}

/**
 * Decide what one Kaana model line becomes, without touching the database.
 * `knownProviders` is the set of provider slugs Oxy holds a reviewed
 * data-policy row for.
 */
export function planKaanaModel(
  entry: KaanaCatalogueModel,
  context: {
    readonly blocked: ReadonlySet<string>;
    readonly knownProviders: ReadonlySet<string>;
    /** Kaana's signed attestation, by exact deployment id. */
    readonly attested: ReadonlyMap<string, KaanaDeploymentDescriptor>;
    /**
     * Reviewed facts for routes whose provider's model list publishes none
     * (`config/kaanaReviewedProviderRoutes.ts`). Their accepted controls are
     * intersected with whatever Kaana publishes for the deployment.
     */
    readonly reviewed?: ReviewedProviderRouteIndex;
  },
): ModelPlan {
  const separator = entry.modelReference.indexOf('@');
  const lineOfReference =
    separator === -1 ? entry.modelReference : entry.modelReference.slice(0, separator);
  if (separator === -1 || lineOfReference !== entry.model) {
    return { status: 'skipped', reason: 'invalid_entry' };
  }
  if (context.blocked.has(entry.model)) return { status: 'skipped', reason: 'blocked' };
  const [publisher, slug] = entry.model.split('/') as [string, string];
  if (publisher === RESERVED_FIRST_PARTY_PUBLISHER) {
    return { status: 'skipped', reason: 'reserved_namespace' };
  }
  if (entry.contextTokens === undefined)
    return { status: 'skipped', reason: 'missing_context_tokens' };
  if (entry.maxOutputTokens === undefined)
    return { status: 'skipped', reason: 'missing_max_output_tokens' };
  if (entry.inputModalities?.some((value) => value.toLowerCase() === 'decisions')) {
    return { status: 'skipped', reason: 'missing_modalities' };
  }
  const inputModalities = knownModalities(entry.inputModalities);
  const outputModalities = [
    ...new Set(
      (entry.outputModalities ?? []).filter((value) =>
        (INFERENCE_OUTPUT_MODALITIES as readonly string[]).includes(value),
      ),
    ),
  ].sort() as InferenceOutputModalityValue[];
  if (inputModalities.length === 0 || outputModalities.length === 0) {
    return { status: 'skipped', reason: 'missing_modalities' };
  }
  if (outputModalities.some((modality) => modality !== 'text')) {
    return { status: 'skipped', reason: 'non_text_output_unreviewed' };
  }
  if (entry.listPrices.length === 0 && entry.invalidDeployments === 0) {
    // Kaana names deployments only through their published price; a line no
    // provider prices cannot be charged for, so it is not offered.
    return { status: 'skipped', reason: 'no_priced_route' };
  }

  const routeSkips: DeploymentSkipReason[] = Array.from(
    { length: entry.invalidDeployments },
    () => 'invalid_descriptor' as const,
  );
  const routes: PlannedRoute[] = [];
  const seenProviders = new Set<string>();
  const seenDeploymentIds = new Set<string>();
  for (const priced of [...entry.listPrices].sort((a, b) =>
    a.deploymentId < b.deploymentId ? -1 : a.deploymentId > b.deploymentId ? 1 : 0,
  )) {
    const deployment = context.attested.get(priced.deploymentId);
    if (
      deployment === undefined ||
      deployment.provider !== priced.provider ||
      deployment.modelReference !== entry.modelReference
    ) {
      routeSkips.push('unattested_route');
      continue;
    }
    if (!context.knownProviders.has(deployment.provider)) {
      routeSkips.push('unknown_provider');
      continue;
    }
    const price = priced.price;
    if (price === 'invalid') {
      routeSkips.push('invalid_list_price');
      continue;
    }
    // One deployment per revision × provider is a database invariant; a second
    // report of the same pair cannot be stored beside the first.
    if (seenProviders.has(deployment.provider) || seenDeploymentIds.has(deployment.deploymentId)) {
      routeSkips.push('duplicate_route');
      continue;
    }
    seenProviders.add(deployment.provider);
    seenDeploymentIds.add(deployment.deploymentId);
    const reviewed = context.reviewed?.get(reviewedRouteKey(deployment.provider, entry.model));
    routes.push({
      deploymentId: deployment.deploymentId,
      provider: deployment.provider,
      regions: deployment.regions,
      price,
      ...(priced.priceEvidenceRef === undefined
        ? {}
        : { priceEvidenceRef: priced.priceEvidenceRef }),
      acceptedParameters: intersectAcceptedParameters(
        acceptedParametersForRoute(entry, deployment),
        reviewed === undefined ? null : reviewed.acceptedParameters,
      ),
    });
  }
  if (routes.length === 0) return { status: 'skipped', reason: 'no_priced_route', routeSkips };

  const reasoningEfforts = MODEL_REASONING_EFFORTS.filter((effort) =>
    (entry.reasoningEfforts ?? []).some((value) => value === effort && KNOWN_EFFORTS.has(value)),
  );
  const providerReleasedAt = entry.createdAt === undefined ? null : new Date(entry.createdAt);
  return {
    status: 'planned',
    model: {
      modelId: entry.model,
      publisher,
      slug,
      revision: entry.modelReference.slice(separator + 1),
      modelReference: entry.modelReference,
      displayName: entry.displayName ?? slug,
      providerReleasedAt,
      maxContextTokens: entry.contextTokens,
      // A model cannot emit more than its window; a report claiming otherwise is
      // clamped to the window rather than trusted to size a hold past it.
      maxOutputTokens: Math.min(entry.maxOutputTokens, entry.contextTokens),
      inputModalities,
      outputModalities,
      supportsTools: entry.supportsTools ?? false,
      reasoningEfforts,
      routes,
      routeSkips,
    },
  };
}

/**
 * The unit prices a synced route is charged at, from the provider list price.
 *
 * Every unit Kaana can report is priced, because an unpriced unit makes a
 * request unquotable: cached input at the published cache-read rate when there
 * is one and otherwise at the full input rate, reasoning at the output rate (the
 * conservative reading when a provider publishes no discount), and `requests`
 * explicitly zero, since Kaana reports `requests: 1` per attempt.
 */
export function syncedUnitPrices(price: KaanaListPrice): {
  readonly unit:
    | 'input_tokens'
    | 'cached_input_tokens'
    | 'output_tokens'
    | 'reasoning_tokens'
    | 'requests';
  readonly amount: string;
  readonly per: number;
}[] {
  return [
    { unit: 'cached_input_tokens', amount: price.cachedInput ?? price.input, per: 1_000_000 },
    { unit: 'input_tokens', amount: price.input, per: 1_000_000 },
    { unit: 'output_tokens', amount: price.output, per: 1_000_000 },
    { unit: 'reasoning_tokens', amount: price.output, per: 1_000_000 },
    { unit: 'requests', amount: '0', per: 1 },
  ];
}

/**
 * The `price` routing score: higher is cheaper. Minus the list price of one
 * million input plus one million output tokens, in US cents, clamped to the
 * column's range. It is a ranking key between routes of one model, not money.
 */
export function syncedPriceScore(price: KaanaListPrice): number {
  const cents = Math.round((Number(price.input) + Number(price.output)) * 100);
  return -Math.min(Math.max(cents, 0), 1_000_000);
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                  */
/* -------------------------------------------------------------------------- */

export interface KaanaCatalogueSyncSummary {
  readonly status: 'synced' | 'skipped';
  readonly reason?: 'not-configured' | 'locked' | 'policy-disabled';
  readonly snapshotId?: string;
  readonly models: {
    readonly reported: number;
    readonly synced: number;
    readonly created: number;
    readonly reviewedUntouched: number;
    readonly skipped: Partial<Record<ModelSkipReason, number>>;
  };
  readonly deployments: {
    readonly upserted: number;
    readonly created: number;
    readonly retired: number;
    /** Routes a presumed-broken report would have retired, left serving. */
    readonly retirementWithheld: number;
    readonly skipped: Partial<Record<DeploymentSkipReason, number>>;
  };
  readonly priceVersionsCreated: number;
  readonly scorecardsWritten: number;
  /** At most 200 `{ modelId, reason }` pairs, for an operator reading the run. */
  readonly skippedModels: readonly { readonly modelId: string; readonly reason: ModelSkipReason }[];
}

export interface KaanaCatalogueSyncOptions {
  readonly reader?: KaanaCatalogueReader;
  readonly now?: Date;
  readonly allowMassRetirement?: boolean;
  /** Defaults to `KAANA_REVIEWED_PROVIDER_ROUTES`. */
  readonly reviewedRoutes?: readonly ReviewedProviderRoute[];
  /**
   * Kaana's credential-economics read. Omitted: the configured signed read;
   * `null`: none (every route's funding is unknown, the synced default).
   */
  readonly economics?: CredentialEconomicsReader | null;
}

interface MutableCounts {
  modelsSynced: number;
  modelsCreated: number;
  reviewedUntouched: number;
  modelSkips: Partial<Record<ModelSkipReason, number>>;
  deploymentsUpserted: number;
  deploymentsCreated: number;
  deploymentSkips: Partial<Record<DeploymentSkipReason, number>>;
  priceVersionsCreated: number;
  scorecardsWritten: number;
  skippedModels: { modelId: string; reason: ModelSkipReason }[];
}

function bump<K extends string>(record: Partial<Record<K, number>>, key: K): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sameUnitPrices(
  actual: readonly { unit: string; amount: string; per: number }[],
  expected: readonly { unit: string; amount: string; per: number }[],
): boolean {
  const key = (rows: readonly { unit: string; amount: string; per: number }[]) =>
    rows
      .map((row) => `${row.unit}:${normalizeDecimal(row.amount) ?? row.amount}:${Number(row.per)}`)
      .sort()
      .join('|');
  return key(actual) === key(expected);
}

/** Find-or-publish the active price version for one route; supersede on change. */
async function ensureSyncedPrice(
  tx: Transaction,
  modelReference: string,
  provider: string,
  price: KaanaListPrice,
  now: Date,
  counts: MutableCounts,
): Promise<string> {
  const expected = syncedUnitPrices(price);
  const [active] = await tx
    .select({
      id: priceVersions.id,
      currency: priceVersions.currency,
      effectiveFrom: priceVersions.effectiveFrom,
      effectiveUntil: priceVersions.effectiveUntil,
    })
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.modelReference, modelReference),
        eq(priceVersions.provider, provider),
        eq(priceVersions.status, 'active'),
      ),
    )
    .for('update');
  if (active !== undefined) {
    const units = await tx
      .select({
        unit: priceVersionUnitPrices.unit,
        amount: priceVersionUnitPrices.amount,
        per: priceVersionUnitPrices.per,
      })
      .from(priceVersionUnitPrices)
      .where(eq(priceVersionUnitPrices.priceVersionId, active.id));
    if (sameUnitPrices(units, expected)) return active.id;
    // A changed list price never rewrites a published version: receipts
    // settled under it stay explainable. It is superseded, and a new one starts.
    await tx
      .update(priceVersions)
      .set({ status: 'superseded', effectiveUntil: now })
      .where(eq(priceVersions.id, active.id));
  }
  const [created] = await tx
    .insert(priceVersions)
    .values({
      status: 'active',
      modelReference,
      provider,
      currency: 'USD',
      effectiveFrom: now,
      effectiveUntil: null,
      supersedesPriceVersionId: active?.id ?? null,
    })
    .returning({ id: priceVersions.id });
  if (created === undefined)
    throw new Error(`price version for ${modelReference}:${provider} was not created`);
  await tx
    .insert(priceVersionUnitPrices)
    .values(expected.map((unit) => ({ priceVersionId: created.id, ...unit })));
  counts.priceVersionsCreated += 1;
  return created.id;
}

/**
 * Keep the route's price-only scorecard aligned with its price version and its
 * funding evidence.
 *
 * `funding` is the route's provider's evidence from Kaana's credential
 * economics (`kaanaCredentialEconomics.service.ts`); absent means unknown, which
 * is the synced default, `standard_payg`. A windowed (promotional) class is
 * renewed once less than half of its window remains, so an unchanged report
 * does not append a scorecard event on every run.
 */
async function ensureSyncedScorecard(
  tx: Transaction,
  deploymentId: string,
  priceVersionId: string,
  price: KaanaListPrice,
  evidenceRef: string,
  funding: ProviderFundingEvidence | undefined,
  now: Date,
  counts: MutableCounts,
): Promise<void> {
  const priceScore = syncedPriceScore(price);
  const economics = {
    fundingClass: funding?.fundingClass ?? ('standard_payg' as const),
    fundingState: funding?.fundingState ?? ('available' as const),
    fundingEvidenceRef: funding?.fundingEvidenceRef ?? evidenceRef,
    fundingObservedAt: funding?.fundingObservedAt ?? null,
    fundingValidUntil: funding?.fundingValidUntil ?? null,
  };
  const [existing] = await tx
    .select({
      priceVersionId: inferenceDeploymentRoutingScores.priceVersionId,
      priceScore: inferenceDeploymentRoutingScores.priceScore,
      fundingClass: inferenceDeploymentRoutingScores.fundingClass,
      fundingState: inferenceDeploymentRoutingScores.fundingState,
      fundingEvidenceRef: inferenceDeploymentRoutingScores.fundingEvidenceRef,
      fundingValidUntil: inferenceDeploymentRoutingScores.fundingValidUntil,
    })
    .from(inferenceDeploymentRoutingScores)
    .where(eq(inferenceDeploymentRoutingScores.deploymentId, deploymentId))
    .for('update');
  if (
    existing !== undefined &&
    existing.priceVersionId === priceVersionId &&
    existing.priceScore === priceScore &&
    existing.fundingClass === economics.fundingClass &&
    existing.fundingState === economics.fundingState &&
    (funding === undefined
      ? existing.fundingValidUntil === null
      : existing.fundingEvidenceRef === economics.fundingEvidenceRef &&
        !fundingNeedsRenewal(existing.fundingValidUntil, now))
  ) {
    return;
  }
  // Latency, throughput and balanced are left unscored (NULL) and immediately
  // stale: Kaana publishes no comparable measurement, and a neutral number would
  // be a claim. The internal default ranks on `price`, which needs neither.
  const card = {
    priceScore,
    priceSource: 'cost_model' as const,
    priceEvidenceRef: evidenceRef,
    priceVersionId,
    latencyScore: null,
    latencySource: 'reviewed_scorecard' as const,
    latencyEvidenceRef: 'not-measured:kaana-sync',
    latencyMeasurementWindowStart: now,
    latencyMeasurementWindowEnd: now,
    latencyValidUntil: now,
    throughputScore: null,
    throughputSource: 'reviewed_scorecard' as const,
    throughputEvidenceRef: 'not-measured:kaana-sync',
    throughputMeasurementWindowStart: now,
    throughputMeasurementWindowEnd: now,
    throughputValidUntil: now,
    balancedScore: null,
    balancedSource: 'cost_model' as const,
    balancedEvidenceRef: 'not-computed:kaana-sync',
    balancedFormulaRef: 'none:kaana-sync-price-only',
    balancedValidUntil: now,
    fundingRemaining: null,
    fundingRemainingUnit: null,
    ...economics,
    reason:
      funding === undefined
        ? 'Kaana sync: price score from the provider list price; no measured latency or throughput.'
        : 'Kaana sync: price score from the provider list price; funding class from Kaana credential economics; no measured latency or throughput.',
    changedByUserId: KAANA_SYNC_ACTOR,
  };
  if (existing === undefined) {
    await tx.insert(inferenceDeploymentRoutingScores).values({
      deploymentId,
      ...card,
      changedAt: now,
    });
  } else {
    await tx
      .update(inferenceDeploymentRoutingScores)
      .set({ ...card, changedAt: now })
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, deploymentId));
  }
  await tx.insert(inferenceDeploymentRoutingScoreEvents).values({
    deploymentId,
    ...card,
    createdAt: now,
  });
  counts.scorecardsWritten += 1;
}

/** Retire synced deployments by primary key. */
async function retireSyncedDeployments(
  tx: Transaction,
  ids: readonly string[],
  note: string,
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const retired = await tx
    .update(inferenceDeployments)
    .set({
      status: 'retired',
      permissionState: 'retired',
      permissionStateChangedAt: now,
      permissionStateChangedByUserId: null,
      permissionStateNote: note,
    })
    .where(
      and(
        inArray(inferenceDeployments.id, [...ids]),
        eq(inferenceDeployments.autoApprovalPolicyId, KAANA_SYNC_AUTO_APPROVAL_POLICY_ID),
      ),
    )
    .returning({ id: inferenceDeployments.id });
  return retired.length;
}

interface ProviderPolicyRow {
  readonly slug: string;
  readonly retainsPayloads: boolean;
  readonly retentionDays: number;
  readonly trainsOnCustomerData: boolean;
  readonly zeroDataRetentionAvailable: boolean;
  readonly subprocessors: string[] | null;
  readonly policyUrl: string | null;
}

/** Write one planned model line. Returns the exact deployment ids it holds. */
async function applyPlannedModel(
  tx: Transaction,
  planned: PlannedModel,
  providers: ReadonlyMap<string, ProviderPolicyRow>,
  evidenceRef: string,
  funding: ProviderFundingIndex,
  now: Date,
  counts: MutableCounts,
): Promise<string[]> {
  await tx
    .insert(inferencePublishers)
    .values({ slug: planned.publisher, displayName: planned.publisher })
    .onConflictDoNothing({ target: inferencePublishers.slug });

  const [existing] = await tx
    .select()
    .from(inferenceModels)
    .where(
      and(
        eq(inferenceModels.publisherSlug, planned.publisher),
        eq(inferenceModels.slug, planned.slug),
      ),
    )
    .for('update');

  if (existing !== undefined && existing.catalogueSource !== 'kaana_sync') {
    // A reviewed line keeps every reviewed fact and every reviewed route; Kaana
    // may only keep its serving capabilities current.
    await tx
      .update(inferenceModels)
      .set({
        reasoningEfforts: [...planned.reasoningEfforts],
        ...(planned.providerReleasedAt === null
          ? {}
          : { providerReleasedAt: planned.providerReleasedAt }),
      })
      .where(eq(inferenceModels.id, existing.id));
    counts.reviewedUntouched += 1;
    return [];
  }

  const modelFacts = {
    displayName: planned.displayName,
    inputModalities: [...planned.inputModalities],
    outputModalities: [...planned.outputModalities],
    supportsTools: planned.supportsTools,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsJsonMode: false,
    supportsReasoning: planned.reasoningEfforts.length > 0,
    // Every text route Kaana executes streams: its adapters emit the normalized
    // event stream whatever the envelope's `stream` flag says.
    supportsStreaming: true,
    supportsPromptCaching: false,
    maxContextTokens: planned.maxContextTokens,
    maxOutputTokens: planned.maxOutputTokens,
    reasoningEfforts: [...planned.reasoningEfforts],
    providerReleasedAt: planned.providerReleasedAt,
  };
  let modelRowId: string;
  if (existing === undefined) {
    const [created] = await tx
      .insert(inferenceModels)
      .values({
        publisherSlug: planned.publisher,
        slug: planned.slug,
        ...modelFacts,
        licenseId: SYNCED_LICENSE.licenseId,
        licenseDisplayName: SYNCED_LICENSE.licenseDisplayName,
        commercialUseAllowed: SYNCED_LICENSE.commercialUseAllowed,
        requiresAttribution: SYNCED_LICENSE.requiresAttribution,
        releaseKind: SYNCED_LICENSE.releaseKind,
        catalogueSource: 'kaana_sync',
      })
      .returning({ id: inferenceModels.id });
    if (created === undefined) throw new Error(`model ${planned.modelId} was not created`);
    modelRowId = created.id;
    counts.modelsCreated += 1;
  } else {
    modelRowId = existing.id;
    await tx.update(inferenceModels).set(modelFacts).where(eq(inferenceModels.id, modelRowId));
  }

  let [revision] = await tx
    .select({ id: inferenceModelRevisions.id, isCurrent: inferenceModelRevisions.isCurrent })
    .from(inferenceModelRevisions)
    .where(
      and(
        eq(inferenceModelRevisions.modelId, modelRowId),
        eq(inferenceModelRevisions.revision, planned.revision),
      ),
    )
    .for('update');
  if (revision === undefined) {
    // `released_at` of an observed revision is when Oxy first observed it:
    // Kaana names revisions by observation, and a provider's model creation
    // date describes the line, not these weights.
    [revision] = await tx
      .insert(inferenceModelRevisions)
      .values({
        modelId: modelRowId,
        revision: planned.revision,
        isCurrent: false,
        releasedAt: now,
      })
      .returning({ id: inferenceModelRevisions.id, isCurrent: inferenceModelRevisions.isCurrent });
    if (revision === undefined)
      throw new Error(`revision ${planned.modelReference} was not created`);
  }
  if (!revision.isCurrent) {
    await tx
      .update(inferenceModelRevisions)
      .set({ isCurrent: false })
      .where(
        and(
          eq(inferenceModelRevisions.modelId, modelRowId),
          eq(inferenceModelRevisions.isCurrent, true),
        ),
      );
    await tx
      .update(inferenceModelRevisions)
      .set({ isCurrent: true })
      .where(eq(inferenceModelRevisions.id, revision.id));
  }
  const revisionId = revision.id;

  const held: string[] = [];
  for (const route of planned.routes) {
    const provider = providers.get(route.provider);
    if (provider === undefined) {
      bump(counts.deploymentSkips, 'unknown_provider');
      continue;
    }
    const deploymentFacts = {
      id: inferenceDeployments.id,
      autoApprovalPolicyId: inferenceDeployments.autoApprovalPolicyId,
      permissionState: inferenceDeployments.permissionState,
      status: inferenceDeployments.status,
    };
    const byId = await tx
      .select(deploymentFacts)
      .from(inferenceDeployments)
      .where(eq(inferenceDeployments.internalRouteId, route.deploymentId))
      .for('update');
    if (byId.some((row) => row.autoApprovalPolicyId === null)) {
      bump(counts.deploymentSkips, 'reviewed_deployment');
      continue;
    }
    const [byRoute] = await tx
      .select(deploymentFacts)
      .from(inferenceDeployments)
      .where(
        and(
          eq(inferenceDeployments.modelRevisionId, revisionId),
          eq(inferenceDeployments.providerSlug, route.provider),
          sql`${inferenceDeployments.privateAutoSourceApproval} is null`,
          or(
            eq(inferenceDeployments.availabilityScope, 'platform_internal'),
            sql`${inferenceDeployments.availabilityScope} = ${LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE}`,
          ),
        ),
      )
      .for('update');
    if (byRoute !== undefined && byRoute.autoApprovalPolicyId === null) {
      bump(counts.deploymentSkips, 'reviewed_deployment');
      continue;
    }
    const priceVersionId = await ensureSyncedPrice(
      tx,
      planned.modelReference,
      route.provider,
      route.price,
      now,
      counts,
    );

    // The same exact id on a different revision/provider row is identity
    // drift: that row no longer describes the deployment, so it is retired
    // before the id is bound to the row that does.
    await retireSyncedDeployments(
      tx,
      byId.filter((row) => row.id !== byRoute?.id && row.status !== 'retired').map((row) => row.id),
      RETIRED_NOTE,
      now,
    );

    const routeFacts = {
      scopedExecution: null,
      privateAutoSourceApproval: null,
      regions: [...route.regions],
      retainsPayloads: provider.retainsPayloads,
      retentionDays: provider.retentionDays,
      trainsOnCustomerData: provider.trainsOnCustomerData,
      zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
      subprocessors: provider.subprocessors,
      policyUrl: provider.policyUrl,
      status: 'active' as const,
      dedicatedCapacity: false,
      priceVersionId,
      internalRouteId: route.deploymentId,
      acceptedParameters: route.acceptedParameters === null ? null : [...route.acceptedParameters],
    };
    const approval = {
      permissionState: 'approved' as const,
      permissionStateChangedAt: now,
      permissionStateChangedByUserId: null,
      permissionStateNote: PERMISSION_NOTE,
      legalReviewStatus: 'approved' as const,
      legalReviewEvidenceRef: LEGAL_EVIDENCE_REF,
      legalReviewedAt: now,
      legalReviewedByUserId: null,
    };
    if (byRoute === undefined) {
      await tx.insert(inferenceDeployments).values({
        modelRevisionId: revisionId,
        providerSlug: route.provider,
        availabilityScope: 'platform_internal',
        commercialPermission: 'standard_application_use',
        autoApprovalPolicyId: KAANA_SYNC_AUTO_APPROVAL_POLICY_ID,
        ...routeFacts,
        ...approval,
      });
      counts.deploymentsCreated += 1;
    } else {
      const revived = byRoute.status === 'retired' || byRoute.permissionState !== 'approved';
      await tx
        .update(inferenceDeployments)
        .set({
          ...routeFacts,
          availabilityScope: 'platform_internal',
          ...(revived ? approval : {}),
        })
        .where(eq(inferenceDeployments.id, byRoute.id));
    }
    await ensureSyncedScorecard(
      tx,
      route.deploymentId,
      priceVersionId,
      route.price,
      route.priceEvidenceRef ?? evidenceRef,
      funding.get(route.provider),
      now,
      counts,
    );
    counts.deploymentsUpserted += 1;
    held.push(route.deploymentId);
  }
  counts.modelsSynced += 1;
  return held;
}

/** The whole write: one transaction, one fleet-wide lock, all or nothing. */
export async function applyKaanaCatalogue(
  catalogue: ParsedKaanaCatalogue,
  attested: ReadonlyMap<string, KaanaDeploymentDescriptor>,
  options: {
    readonly now?: Date;
    readonly allowMassRetirement?: boolean;
    /** Reviewed facts for routes whose provider publishes none; see {@link planKaanaModel}. */
    readonly reviewed?: ReviewedProviderRouteIndex;
    /** Each provider's funding evidence; a provider absent is unknown (`standard_payg`). */
    readonly funding?: ProviderFundingIndex;
  } = {},
): Promise<KaanaCatalogueSyncSummary> {
  const now = options.now ?? new Date();
  if (catalogue.models.length === 0) {
    // Kaana always serves something; an empty report is a broken one, and
    // syncing it would retire every synced route.
    throw new Error('Kaana reported an empty catalogue; refusing to sync it');
  }
  const evidenceRef = `kaana-list-price:${catalogue.snapshotId ?? 'unknown-snapshot'}`.slice(
    0,
    500,
  );

  return getDb().transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${SYNC_LOCK_NAMESPACE}, 0)) as locked`,
    );
    const emptyCounts = {
      models: {
        reported: catalogue.models.length,
        synced: 0,
        created: 0,
        reviewedUntouched: 0,
        skipped: {},
      },
      deployments: { upserted: 0, created: 0, retired: 0, retirementWithheld: 0, skipped: {} },
      priceVersionsCreated: 0,
      scorecardsWritten: 0,
      skippedModels: [],
    };
    if (lock?.locked !== true) {
      return {
        status: 'skipped',
        reason: 'locked',
        snapshotId: catalogue.snapshotId,
        ...emptyCounts,
      };
    }
    const [policy] = await tx
      .select({ enabled: inferenceCatalogueAutoApprovalPolicies.enabled })
      .from(inferenceCatalogueAutoApprovalPolicies)
      .where(eq(inferenceCatalogueAutoApprovalPolicies.id, KAANA_SYNC_AUTO_APPROVAL_POLICY_ID));
    if (policy?.enabled !== true) {
      return {
        status: 'skipped',
        reason: 'policy-disabled',
        snapshotId: catalogue.snapshotId,
        ...emptyCounts,
      };
    }

    const blocked = new Set(
      (
        await tx
          .select({ modelId: inferenceCatalogueBlocklist.modelId })
          .from(inferenceCatalogueBlocklist)
      ).map((row) => row.modelId),
    );
    const providerRows = await tx
      .select({
        slug: inferenceProviders.slug,
        kind: inferenceProviders.kind,
        retainsPayloads: inferenceProviders.retainsPayloads,
        retentionDays: inferenceProviders.retentionDays,
        trainsOnCustomerData: inferenceProviders.trainsOnCustomerData,
        zeroDataRetentionAvailable: inferenceProviders.zeroDataRetentionAvailable,
        subprocessors: inferenceProviders.subprocessors,
        policyUrl: inferenceProviders.policyUrl,
      })
      .from(inferenceProviders);
    // Only providers Oxy itself pays: a BYOK provider row describes a
    // customer's own account, never a platform route.
    const providers = new Map(
      providerRows.filter((row) => row.kind !== 'customer_byok').map((row) => [row.slug, row]),
    );

    const counts: MutableCounts = {
      modelsSynced: 0,
      modelsCreated: 0,
      reviewedUntouched: 0,
      modelSkips: {},
      deploymentsUpserted: 0,
      deploymentsCreated: 0,
      deploymentSkips: {},
      priceVersionsCreated: 0,
      scorecardsWritten: 0,
      skippedModels: [],
    };
    for (let index = 0; index < catalogue.invalidEntries; index += 1)
      bump(counts.modelSkips, 'invalid_entry');

    const held = new Set<string>();
    const seenLines = new Set<string>();
    for (const entry of catalogue.models) {
      if (seenLines.has(entry.model)) {
        bump(counts.modelSkips, 'invalid_entry');
        continue;
      }
      seenLines.add(entry.model);
      const plan = planKaanaModel(entry, {
        blocked,
        knownProviders: new Set(providers.keys()),
        attested,
        ...(options.reviewed === undefined ? {} : { reviewed: options.reviewed }),
      });
      for (const skip of plan.status === 'planned'
        ? plan.model.routeSkips
        : (plan.routeSkips ?? [])) {
        bump(counts.deploymentSkips, skip);
      }
      if (plan.status === 'skipped') {
        bump(counts.modelSkips, plan.reason);
        if (counts.skippedModels.length < MAX_REPORTED_SKIPS) {
          counts.skippedModels.push({ modelId: entry.model, reason: plan.reason });
        }
        continue;
      }
      for (const deploymentId of await applyPlannedModel(
        tx,
        plan.model,
        providers,
        evidenceRef,
        options.funding ?? new Map(),
        now,
        counts,
      )) {
        held.add(deploymentId);
      }
    }

    const live = await tx
      .select({
        id: inferenceDeployments.id,
        internalRouteId: inferenceDeployments.internalRouteId,
      })
      .from(inferenceDeployments)
      .where(
        and(
          eq(inferenceDeployments.autoApprovalPolicyId, KAANA_SYNC_AUTO_APPROVAL_POLICY_ID),
          ne(inferenceDeployments.status, 'retired'),
        ),
      );
    const stale = live.filter(
      (row) => row.internalRouteId === null || !held.has(row.internalRouteId),
    );
    const massRetirement =
      live.length > 0 && stale.length / live.length > MAX_ROUTINE_RETIREMENT_FRACTION;
    let retired = 0;
    let retirementWithheld = 0;
    if (massRetirement && options.allowMassRetirement !== true) {
      retirementWithheld = stale.length;
      logger.error(
        'inference.catalogue_sync.retirement_withheld',
        new Error(`the Kaana report would retire ${stale.length} of ${live.length} synced routes`),
        { snapshotId: catalogue.snapshotId, stale: stale.length, live: live.length },
      );
    } else {
      retired = await retireSyncedDeployments(
        tx,
        stale.map((row) => row.id),
        RETIRED_NOTE,
        now,
      );
    }

    return {
      status: 'synced',
      snapshotId: catalogue.snapshotId,
      models: {
        reported: catalogue.models.length + catalogue.invalidEntries,
        synced: counts.modelsSynced,
        created: counts.modelsCreated,
        reviewedUntouched: counts.reviewedUntouched,
        skipped: counts.modelSkips,
      },
      deployments: {
        upserted: counts.deploymentsUpserted,
        created: counts.deploymentsCreated,
        retired,
        retirementWithheld,
        skipped: counts.deploymentSkips,
      },
      priceVersionsCreated: counts.priceVersionsCreated,
      scorecardsWritten: counts.scorecardsWritten,
      skippedModels: counts.skippedModels,
    };
  });
}

/**
 * Resolve every priced deployment id through Kaana's signed attestation, in
 * batches of its maximum. The catalogue names a deployment and its provider but
 * not its attested region set, and the region set is part of the identity the
 * edge later signs and Kaana compares; taking it from the attestation means the
 * stored route is byte-for-byte the one the preflight will accept.
 */
export async function attestPricedDeployments(
  reader: KaanaCatalogueReader,
  catalogue: ParsedKaanaCatalogue,
): Promise<Map<string, KaanaDeploymentDescriptor>> {
  const pricedRoutes = new Map<string, KaanaPricedRoute>();
  for (const model of catalogue.models)
    for (const route of model.listPrices) {
      if (route.price === 'invalid') continue;
      const existing = pricedRoutes.get(route.deploymentId);
      if (existing !== undefined && !isDeepStrictEqual(existing, route)) {
        throw new Error('Catalogue repeats a deployment with conflicting price.');
      }
      pricedRoutes.set(route.deploymentId, route);
    }
  const attested = new Map<string, KaanaDeploymentDescriptor>();
  const ids = [...pricedRoutes.keys()].sort();
  for (let start = 0; start < ids.length; start += KAANA_ATTESTATION_BATCH) {
    const batch = ids.slice(start, start + KAANA_ATTESTATION_BATCH);
    const evidence = await reader.attestDeployments(batch, {
      signal: AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS),
    });
    if (
      evidence.deployments.length !== batch.length ||
      new Set(evidence.deployments.map((row) => row.deploymentId)).size !== batch.length ||
      evidence.deployments.some((row) => !batch.includes(row.deploymentId))
    ) {
      throw new Error('Deployment attestation must contain exactly the requested identities.');
    }
    for (const descriptor of evidence.deployments) {
      const route = pricedRoutes.get(descriptor.deploymentId);
      if (route === undefined)
        throw new Error('Deployment attestation lacks its exact priced route.');
      if (descriptor.provider !== route.provider) {
        throw new Error('Deployment attestation changed its provider.');
      }
      attested.set(descriptor.deploymentId, {
        deploymentId: descriptor.deploymentId,
        provider: descriptor.provider,
        modelReference: descriptor.modelReference,
        regions: [...new Set(descriptor.regions)].sort(),
        ...(descriptor.acceptedParameters === undefined
          ? {}
          : { acceptedParameters: descriptor.acceptedParameters }),
      });
    }
  }
  return attested;
}

/**
 * The reviewed facts a line could use: a provider Kaana says serves the line,
 * with a reviewed route for that exact `(provider, line)`, and no list price
 * of its own in Kaana's report (a Kaana-published price always wins).
 */
function reviewedRoutesOf(
  entry: KaanaCatalogueModel,
  reviewed: ReviewedProviderRouteIndex,
): ReviewedProviderRoute[] {
  const routes: ReviewedProviderRoute[] = [];
  for (const provider of new Set(entry.providers ?? [])) {
    const route = reviewed.get(reviewedRouteKey(provider, entry.model));
    if (route === undefined) continue;
    if (entry.listPrices.some((priced) => priced.provider === provider)) continue;
    routes.push(route);
  }
  return routes;
}

/** Whether any line of the report can use a reviewed route, so the snapshot must be read. */
export function reviewedRoutesWanted(
  catalogue: ParsedKaanaCatalogue,
  reviewed: ReviewedProviderRouteIndex,
): boolean {
  return (
    reviewed.size > 0 &&
    catalogue.models.some((entry) => reviewedRoutesOf(entry, reviewed).length > 0)
  );
}

/**
 * Name the deployments of providers whose model list publishes no price.
 *
 * Kaana's catalogue names a deployment only through its `listPrices` row, so a
 * direct Anthropic deployment appears in a line's `providers` and nowhere else.
 * Its exact id, provider and revision-pinned reference come from Kaana's signed
 * serving snapshot (the `{}` deployment query the edge's publication cache also
 * reads), and its price from the reviewed provider route. The result goes
 * through the same exact attestation and planning as every Kaana-priced route.
 */
export function withReviewedRoutes(
  catalogue: ParsedKaanaCatalogue,
  published: Pick<KaanaDeploymentAttestation, 'deployments'>,
  reviewed: ReviewedProviderRouteIndex,
): ParsedKaanaCatalogue {
  return {
    ...catalogue,
    models: catalogue.models.map((entry) => {
      const additions: KaanaPricedRoute[] = [];
      for (const route of reviewedRoutesOf(entry, reviewed)) {
        for (const descriptor of published.deployments) {
          if (
            descriptor.provider !== route.provider ||
            descriptor.modelReference !== entry.modelReference ||
            entry.listPrices.some((priced) => priced.deploymentId === descriptor.deploymentId)
          ) {
            continue;
          }
          additions.push({
            deploymentId: descriptor.deploymentId,
            provider: route.provider,
            price: { ...route.price },
            priceEvidenceRef: route.priceEvidenceRef,
          });
        }
      }
      return additions.length === 0
        ? entry
        : { ...entry, listPrices: [...entry.listPrices, ...additions] };
    }),
  };
}

/**
 * Each provider's funding evidence from one credential-economics read, or
 * nothing when the read is not configured or fails. Unknown funding is the
 * synced default, so a failed read never stops the catalogue from syncing; it
 * only withholds a cheaper class nobody proved this run.
 */
async function readFundingEvidence(
  reader: CredentialEconomicsReader | undefined,
  now: Date,
): Promise<ProviderFundingIndex> {
  if (reader === undefined) return new Map();
  try {
    return fundingEvidenceByProvider(
      await reader.read(AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS)),
      now,
    );
  } catch (error) {
    logger.warn('inference.catalogue_sync.credential_economics_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/** Fetch Kaana's catalogue and apply it. */
export async function runKaanaCatalogueSync(
  options: KaanaCatalogueSyncOptions = {},
): Promise<KaanaCatalogueSyncSummary> {
  const reader = options.reader ?? createHttpKaanaCatalogueReader();
  if (reader === undefined) {
    return {
      status: 'skipped',
      reason: 'not-configured',
      models: { reported: 0, synced: 0, created: 0, reviewedUntouched: 0, skipped: {} },
      deployments: { upserted: 0, created: 0, retired: 0, retirementWithheld: 0, skipped: {} },
      priceVersionsCreated: 0,
      scorecardsWritten: 0,
      skippedModels: [],
    };
  }
  const reviewed = indexReviewedProviderRoutes(options.reviewedRoutes);
  let catalogue = parseKaanaCatalogue(
    await reader.listModels(AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS)),
  );
  if (reviewedRoutesWanted(catalogue, reviewed)) {
    catalogue = withReviewedRoutes(
      catalogue,
      await reader.listPublishedDeployments(AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS)),
      reviewed,
    );
  }
  const attested = await attestPricedDeployments(reader, catalogue);
  const funding = await readFundingEvidence(
    options.economics === undefined
      ? createHttpKaanaCredentialEconomicsReader()
      : (options.economics ?? undefined),
    options.now ?? new Date(),
  );
  const summary = await applyKaanaCatalogue(catalogue, attested, {
    ...options,
    reviewed,
    funding,
  });
  logger.info('inference.catalogue_sync.completed', {
    status: summary.status,
    reason: summary.reason,
    snapshotId: summary.snapshotId,
    modelsReported: summary.models.reported,
    modelsSynced: summary.models.synced,
    modelsCreated: summary.models.created,
    modelSkips: summary.models.skipped,
    deploymentsUpserted: summary.deployments.upserted,
    deploymentsRetired: summary.deployments.retired,
    retirementWithheld: summary.deployments.retirementWithheld,
    deploymentSkips: summary.deployments.skipped,
    priceVersionsCreated: summary.priceVersionsCreated,
  });
  return summary;
}

/* -------------------------------------------------------------------------- */
/*  Blocklist                                                                 */
/* -------------------------------------------------------------------------- */

export interface CatalogueBlock {
  readonly modelId: string;
  readonly reason: string;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
}

export async function listCatalogueBlocks(): Promise<CatalogueBlock[]> {
  const rows = await getDb()
    .select()
    .from(inferenceCatalogueBlocklist)
    .orderBy(inferenceCatalogueBlocklist.modelId);
  return rows.map((row) => ({
    modelId: row.modelId,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Block a model line and retire its synced routes in the same commit, so the
 * brake takes effect now rather than at the next sync. Reviewed routes of the
 * line are not the sync's to retire; staff retire those through the
 * permission surface.
 */
export async function blockCatalogueModel(input: {
  readonly modelId: string;
  readonly reason: string;
  readonly userId: string | null;
}): Promise<{ readonly created: boolean; readonly retired: number }> {
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(inferenceCatalogueBlocklist)
      .values({
        modelId: input.modelId,
        reason: input.reason.trim(),
        createdByUserId: input.userId,
      })
      .onConflictDoNothing({ target: inferenceCatalogueBlocklist.modelId })
      .returning({ id: inferenceCatalogueBlocklist.id });
    const revisionsOfLine = tx
      .select({ id: inferenceModelRevisions.id })
      .from(inferenceModelRevisions)
      .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
      .where(eq(inferenceModels.modelId, input.modelId));
    const targets = await tx
      .select({ id: inferenceDeployments.id })
      .from(inferenceDeployments)
      .where(
        and(
          eq(inferenceDeployments.autoApprovalPolicyId, KAANA_SYNC_AUTO_APPROVAL_POLICY_ID),
          ne(inferenceDeployments.status, 'retired'),
          inArray(inferenceDeployments.modelRevisionId, revisionsOfLine),
        ),
      )
      .for('update');
    const retired = await retireSyncedDeployments(
      tx,
      targets.map((row) => row.id),
      BLOCKED_NOTE,
      now,
    );
    return { created: inserted.length === 1, retired };
  });
}

/** Lift a block. The line's routes return at the next sync, not before. */
export async function unblockCatalogueModel(modelId: string): Promise<boolean> {
  const removed = await getDb()
    .delete(inferenceCatalogueBlocklist)
    .where(eq(inferenceCatalogueBlocklist.modelId, modelId))
    .returning({ id: inferenceCatalogueBlocklist.id });
  return removed.length === 1;
}

/* -------------------------------------------------------------------------- */
/*  Schedule                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Register the fleet-wide schedule. Every API task registers it; the advisory
 * lock lets exactly one run at a time and the rest return `locked`. A task with
 * no Kaana binding registers nothing.
 */
export function startKaanaCatalogueSyncSchedule(): PeriodicJob | undefined {
  if (createHttpKaanaCatalogueReader() === undefined) {
    logger.info('inference.catalogue_sync.not_configured', {
      component: 'inference-catalogue-sync',
    });
    return undefined;
  }
  return schedulePeriodicJob({
    failureMessage: 'inference.catalogue_sync.failed',
    intervalMs: KAANA_CATALOGUE_SYNC_INTERVAL_MS,
    firstRunDelayMs: KAANA_CATALOGUE_SYNC_FIRST_RUN_DELAY_MS,
    run: async () => {
      await runKaanaCatalogueSync();
    },
  });
}
