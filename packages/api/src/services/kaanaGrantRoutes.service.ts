/**
 * The model lines a grant can admit, resolved from KAANA's catalogue.
 *
 * Kaana ADR 0002, amendment 2026-10-15: the model catalogue is Kaana's, so a
 * grant takes a line's identity, audience, capabilities, licence, data policy
 * and LIST PRICE from the `declaredCatalogue` of Kaana's signed
 * `GET /internal/v1/models` (`kaanaDeclaredCatalogue.service.ts`), and the
 * routes that serve it — with how each may be SOLD — from the deployments Kaana
 * publishes (`kaanaDeploymentPublication.service.ts`, `commercial` on the
 * descriptor). This module replaces, on the grant path, `resolveEdgeRoute`,
 * which reads Oxy's own model, revision, price-version and scorecard tables;
 * those serve the old edge (`api.oxy.so/v1`) until phase 5 deletes them, and a
 * guard test (`kaanaGrantCatalogueGuard.test.ts`) fails if this path, the grant
 * or the settlement reaches them — or `inference_deployments`.
 *
 * ## What is still Oxy's
 *
 *  - The application's POLICY (`RoutingConstraints`: providers, regions, data
 *    controls, licences, price caps), the allowed power levels and the limits.
 *  - The customer's provider connections (BYOK): which key the customer
 *    connected is the customer's configuration.
 *  - The BYOK platform fee, which is Oxy billing configuration
 *    (`config/inferencePlatformFee.ts`), not a model price.
 *
 * ## What it does not do
 *
 *  - It ranks nothing and picks no provider. Kaana chooses provider and key —
 *    cheapest first, with failover and recovery (owner decision 2026-10-12) —
 *    among the routes the grant admits. This module admits EVERY eligible
 *    route of the line under the application's policy, in a fixed order
 *    (provider, then deployment id) so a grant is reproducible.
 *  - It validates no revision. The declared catalogue names a model, not its
 *    revisions; a pinned `@revision` is held to the deployments Kaana publishes
 *    for it.
 *
 * ## Two price lanes
 *
 *  - **list**: a route Kaana serves on its own keys, rated at the model's
 *    declared list. A model with no `pricing` has no list lane.
 *  - **byok**: a `byok_only` route the application has a ready connection for,
 *    rated ONLY at Oxy's platform fee. The grant is then `platform_fee_only`
 *    and carries the customer's credential binding.
 */

import type { DeclaredModel } from '@kaana.ai/contracts/internal';
import type { AuthorizedRoute, InferenceEnvironment, UsageUnit } from '@oxy.so/contracts';
import {
  type CandidatePrice,
  type CatalogueViewer,
  type EdgeCapacityRequirement,
  type EdgeModalityRequirement,
  type RoutingConstraint,
  type RoutingConstraints,
  capabilityAdmits,
  violatedConstraints,
} from './inferenceCatalogue.service';
import { activePlatformFeeSchedule, platformFeePriceList } from '../config/inferencePlatformFee';
import type { PriceSnapshotInput } from './inferenceLedger.service';
import { resolveProviderConnectionForApplication } from './inferenceProviderConnection.service';
import {
  audienceAdmits,
  type DeclaredCatalogueObservation,
  DeclaredPriceError,
  isCallable,
  requirePriceSnapshot,
} from './kaanaDeclaredCatalogue.service';
import type { PublishedRoute } from './kaanaDeploymentPublication.service';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** The customer's own key for a BYOK route (Oxy's provider connection). */
export type GrantCustomerCredential = NonNullable<AuthorizedRoute['customerProviderCredential']>;

/** One deployment a grant may let Kaana choose. */
export interface GrantRoute {
  /** Kaana's exact deployment id. */
  readonly deploymentId: string;
  /** `publisher/model@revision`, as Kaana's inventory names it. */
  readonly modelReference: string;
  readonly provider: string;
  readonly regions: readonly string[];
  readonly availabilityScope: string;
  /** Present only on a BYOK route: the connection the customer made. */
  readonly customerProviderCredential?: GrantCustomerCredential;
}

/**
 * The routes of a line that are rated the same way. `list`: Kaana's own keys,
 * at the declared list. `byok`: the customer's key, at Oxy's platform fee only.
 */
export interface GrantLane {
  readonly kind: 'list' | 'byok';
  readonly price: PriceSnapshotInput;
  /** At least one, in (provider, deployment id) order, after the application's policy. */
  readonly routes: readonly GrantRoute[];
}

/** A model line the grant can admit: the declared model and the lanes it can be served in. */
export interface GrantLine {
  readonly modelLine: string;
  readonly model: DeclaredModel;
  /** At least one lane; the preferred lane first. */
  readonly lanes: readonly GrantLane[];
  /** The line's ceilings, from its declared capabilities. */
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /**
   * The most input tokens one image costs on the line (its declared
   * `imageInput`, Kaana ADR 0006); absent, the line serves no image.
   */
  readonly maxInputTokensPerImage: number | undefined;
}

/**
 * What a request needs of a line's context: its text input and output, and the
 * images it carries, each bounded at the line's own declared cost per image.
 */
export interface GrantCapacityRequirement extends EdgeCapacityRequirement {
  /** Image parts the input carries (`facts.inputImages`); absent or 0: none. */
  readonly inputImages?: number;
}

export type GrantLineResolution =
  | { readonly status: 'resolved'; readonly line: GrantLine }
  | { readonly status: 'unknown-model'; readonly modelReference: string }
  | {
      readonly status: 'model-not-priced';
      readonly modelReference: string;
      readonly error: DeclaredPriceError;
    }
  /** Only customer-key routes exist and Oxy has no approved platform fee to rate them at. */
  | { readonly status: 'platform-fee-unavailable'; readonly modelReference: string }
  | {
      readonly status: 'modality-unsupported';
      readonly modelReference: string;
    }
  | { readonly status: 'capability-unsupported'; readonly modelReference: string }
  | {
      readonly status: 'capacity-unavailable';
      readonly modelReference: string;
      readonly outputLimitExceeded: boolean;
      readonly contextLimitExceeded: boolean;
    }
  | { readonly status: 'no-published-route'; readonly modelReference: string }
  | {
      readonly status: 'policy-excluded';
      readonly modelReference: string;
      readonly constraints: readonly RoutingConstraint[];
    };

export interface GrantRoutingEvidence {
  readonly catalogue: DeclaredCatalogueObservation;
  /** Every deployment Kaana publishes right now, with what its descriptor says. */
  readonly published: ReadonlyMap<string, PublishedRoute>;
}

/** The authenticated application a grant is for: its BYOK connections are looked up by it. */
export interface GrantApplicationContext {
  readonly applicationId: string;
  readonly environment: InferenceEnvironment;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `publisher/model` of a reference that may carry `@revision`. */
function splitReference(reference: string): { modelId: string; revision: string | undefined } {
  const separator = reference.indexOf('@');
  return separator === -1
    ? { modelId: reference, revision: undefined }
    : { modelId: reference.slice(0, separator), revision: reference.slice(separator + 1) };
}

function compareRoutes(left: GrantRoute, right: GrantRoute): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.deploymentId === right.deploymentId) return 0;
  return left.deploymentId < right.deploymentId ? -1 : 1;
}

/**
 * Whether Kaana's `commercial` publication lets Oxy sell this deployment to this
 * audience: a scope the viewer holds (customer-key routes are decided apart,
 * by the customer's connection), and a permission that agrees with the scope —
 * `customer_byok` is the permission of exactly the `byok_only` scope.
 */
function sellable(route: PublishedRoute, viewer: CatalogueViewer): boolean {
  const commercial = route.commercial;
  if (commercial === undefined) return false;
  const byok = commercial.availabilityScope === 'byok_only';
  if (byok !== (commercial.commercialPermission === 'customer_byok')) return false;
  return byok || viewer.scopes.includes(commercial.availabilityScope);
}

/* -------------------------------------------------------------------------- */
/*  resolveGrantLine                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `modelReference` (`publisher/model`, `@revision` when pinned) to the
 * line a grant can admit for this viewer, request shape and policy, or say why
 * it cannot. The statuses are the ones `resolveEdgeRoute` answered, so the
 * grant's refusals keep their wording.
 *
 * Order, and why: a model that does not exist or is not this audience's is a
 * request error and says nothing else; what the model cannot do (modality,
 * dialect, capacity) comes before the customer's own policy, because only one
 * of them is theirs to fix; routes are looked at before price, and a line with
 * routes but nothing to rate them at is refused typed, never rated at zero.
 */
export async function resolveGrantLine(
  evidence: GrantRoutingEvidence,
  viewer: CatalogueViewer,
  application: GrantApplicationContext,
  modelReference: string,
  constraints: RoutingConstraints,
  modality: EdgeModalityRequirement,
  capacity: GrantCapacityRequirement,
): Promise<GrantLineResolution> {
  if (viewer.scopes.length === 0) return { status: 'unknown-model', modelReference };
  const { modelId, revision } = splitReference(modelReference);
  const model = evidence.catalogue.models.get(modelId);
  if (model === undefined || !audienceAdmits(viewer.scopes, model) || !isCallable(model)) {
    return { status: 'unknown-model', modelReference };
  }

  const { capabilities } = model;
  if (
    !capabilities.inputModalities.includes(modality.input) ||
    (modality.output !== undefined && !capabilities.outputModalities.includes(modality.output))
  ) {
    return { status: 'modality-unsupported', modelReference };
  }
  if (
    !capabilityAdmits(
      {
        apiFormats: capabilities.apiFormats ?? null,
        realtimeTransports: capabilities.realtime?.transports ?? null,
        realtimeSessionKinds: capabilities.realtime?.sessionKinds ?? null,
      },
      modality,
    )
  ) {
    return { status: 'capability-unsupported', modelReference };
  }
  // Images need the line to say what one costs: taking `image` input is not a
  // bound a hold can be sized from (Kaana ADR 0006).
  const inputImages = capacity.inputImages ?? 0;
  if (inputImages > 0 && model.imageInput === undefined) {
    return { status: 'capability-unsupported', modelReference };
  }
  const inputTokens =
    capacity.inputTokens + inputImages * (model.imageInput?.maxInputTokensPerImage ?? 0);

  const outputTokens =
    capacity.outputTokens === 'model-maximum'
      ? capabilities.maxOutputTokens
      : capacity.outputTokens;
  if (
    capabilities.maxOutputTokens < outputTokens ||
    capabilities.maxContextTokens < inputTokens + outputTokens
  ) {
    const explicit = capacity.outputTokens === 'model-maximum' ? undefined : capacity.outputTokens;
    return {
      status: 'capacity-unavailable',
      modelReference,
      outputLimitExceeded: explicit !== undefined && capabilities.maxOutputTokens < explicit,
      contextLimitExceeded: capabilities.maxContextTokens < inputTokens + outputTokens,
    };
  }

  // The routes Kaana publishes for this line (and revision, when pinned) that
  // Kaana says may be sold to this audience.
  const candidates: GrantRoute[] = [];
  const connections = new Map<string, Promise<GrantCustomerCredential | undefined>>();
  for (const route of evidence.published.values()) {
    const reference = splitReference(route.modelReference);
    if (
      reference.modelId !== modelId ||
      (revision !== undefined && reference.revision !== revision)
    ) {
      continue;
    }
    if (!sellable(route, viewer) || route.commercial === undefined) continue;
    const base: GrantRoute = {
      deploymentId: route.deploymentId,
      modelReference: route.modelReference,
      provider: route.provider,
      regions: route.regions,
      availabilityScope: route.commercial.availabilityScope,
    };
    if (route.commercial.availabilityScope !== 'byok_only') {
      candidates.push(base);
      continue;
    }
    // A customer-key route exists for this application only if the customer
    // connected a ready, valid key for the provider.
    let connection = connections.get(route.provider);
    if (connection === undefined) {
      connection = resolveProviderConnectionForApplication({
        applicationId: application.applicationId,
        provider: route.provider,
        environment: application.environment,
      }).then((resolution) =>
        resolution.status === 'resolved' &&
        resolution.connection.credentialHandle !== undefined &&
        resolution.connection.credentialRevision !== undefined
          ? {
              credentialHandle: resolution.connection.credentialHandle,
              credentialRevision: resolution.connection.credentialRevision,
              ownerAccountId: resolution.connection.ownerAccountId,
              connectionId: resolution.connection.connectionId,
              environment: resolution.connection.environment,
            }
          : undefined,
      );
      connections.set(route.provider, connection);
    }
    const credential = await connection;
    if (credential !== undefined)
      candidates.push({ ...base, customerProviderCredential: credential });
  }
  if (candidates.length === 0) return { status: 'no-published-route', modelReference };

  // The application's policy over the declared facts: licence and data policy
  // are the MODEL's (declared by Kaana), regions, provider and scope the
  // ROUTE's; the price caps compare against the lane's own price.
  const declared =
    model.pricing === undefined ? undefined : priceSnapshotOfDeclared(evidence, model);
  const fee = activePlatformFeeSchedule();
  const feeList = fee === undefined ? undefined : platformFeePriceList(fee);
  const kept: { readonly route: GrantRoute; readonly price: PriceSnapshotInput }[] = [];
  const excludedBy: RoutingConstraint[] = [];
  let unpriced: 'model' | 'fee' | undefined;
  for (const candidate of candidates) {
    const byok = candidate.customerProviderCredential !== undefined;
    const price = byok ? feeList : declared;
    if (price === undefined) {
      unpriced ??= byok ? 'fee' : 'model';
      continue;
    }
    const violated = violatedConstraints(
      constraints,
      {
        providerSlug: candidate.provider,
        availabilityScope: candidate.availabilityScope,
        regions: candidate.regions,
        retainsPayloads: model.dataPolicy.retainsPayloads,
        retentionDays: model.dataPolicy.retentionDays,
        trainsOnCustomerData: model.dataPolicy.trainsOnCustomerData,
        zeroDataRetentionAvailable: model.dataPolicy.zeroDataRetentionAvailable,
        dedicatedCapacity: dedicatedOf(evidence, candidate.deploymentId),
        licenseId: model.license.licenseId,
        commercialUseAllowed: model.license.commercialUseAllowed,
        priceVersionId: price.priceVersionId,
      },
      candidatePriceOf(price),
    );
    if (violated.length === 0) {
      kept.push({ route: candidate, price });
      continue;
    }
    for (const constraint of violated) {
      if (!excludedBy.includes(constraint)) excludedBy.push(constraint);
    }
  }
  if (kept.length === 0) {
    if (unpriced === 'fee') return { status: 'platform-fee-unavailable', modelReference };
    if (unpriced === 'model') {
      return {
        status: 'model-not-priced',
        modelReference,
        error: new DeclaredPriceError(
          'model_not_priced',
          `${model.modelId} declares no price per unit.`,
          { modelId: model.modelId },
        ),
      };
    }
    return { status: 'policy-excluded', modelReference, constraints: excludedBy };
  }

  const lanes: GrantLane[] = [];
  for (const kind of ['list', 'byok'] as const) {
    const entries = kept.filter(
      (entry) => (entry.route.customerProviderCredential !== undefined) === (kind === 'byok'),
    );
    const [first] = entries;
    if (first === undefined) continue;
    lanes.push({
      kind,
      price: first.price,
      routes: entries.map((entry) => entry.route).sort(compareRoutes),
    });
  }
  // Which lane a grant is served in: the customer's key only when the policy
  // prefers it or Kaana's own keys have no eligible route.
  if (constraints.byokPreference === 'prefer')
    lanes.sort((left, right) => (left.kind === 'byok' ? -1 : right.kind === 'byok' ? 1 : 0));

  return {
    status: 'resolved',
    line: {
      modelLine: modelId,
      model,
      lanes,
      maxContextTokens: capabilities.maxContextTokens,
      maxOutputTokens: capabilities.maxOutputTokens,
      maxInputTokensPerImage: model.imageInput?.maxInputTokensPerImage,
    },
  };
}

function priceSnapshotOfDeclared(
  evidence: GrantRoutingEvidence,
  model: DeclaredModel,
): PriceSnapshotInput | undefined {
  try {
    return requirePriceSnapshot(evidence.catalogue, model);
  } catch (error) {
    if (error instanceof DeclaredPriceError) return undefined;
    throw error;
  }
}

function dedicatedOf(evidence: GrantRoutingEvidence, deploymentId: string): boolean {
  return evidence.published.get(deploymentId)?.commercial?.dedicatedCapacity ?? false;
}

function candidatePriceOf(price: PriceSnapshotInput): CandidatePrice {
  return {
    currency: price.currency,
    unitPrices: price.unitPrices.map((entry) => ({
      unit: entry.unit as UsageUnit,
      amount: entry.amount,
      per: entry.per,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Power levels                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The model lines of a power level for this audience, in priority order: each
 * level's declared `powerClass` (Kaana's reviewed statement, new in the
 * declared catalogue), one priority per level, a model listed once at its first
 * level (`xhigh` shares `high`'s class). Whether a line is SERVABLE is decided
 * by the caller, by resolving it.
 */
export function powerLevelLines<Level extends string>(
  catalogue: DeclaredCatalogueObservation,
  viewer: CatalogueViewer,
  levels: readonly Level[],
  classOf: (level: Level) => string,
): string[] {
  if (viewer.scopes.length === 0) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const level of levels) {
    const matching = [...catalogue.models.values()]
      .filter(
        (model) =>
          model.powerClass === classOf(level) &&
          audienceAdmits(viewer.scopes, model) &&
          isCallable(model),
      )
      .map((model) => model.modelId)
      .sort();
    for (const modelId of matching) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      lines.push(modelId);
    }
  }
  return lines;
}
