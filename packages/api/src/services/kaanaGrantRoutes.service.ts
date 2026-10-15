/**
 * The model lines a grant can admit, resolved from KAANA's catalogue.
 *
 * Kaana ADR 0002, amendment 2026-10-15: the model catalogue is Kaana's, so a
 * grant takes a line's identity, audience, capabilities, licence, data policy
 * and LIST PRICE from the `declaredCatalogue` of Kaana's signed
 * `GET /internal/v1/models` (`kaanaDeclaredCatalogue.service.ts`), and the
 * routes that serve it from the deployments Kaana publishes
 * (`kaanaDeploymentPublication.service.ts`). This module is the replacement,
 * on the grant path, of `resolveEdgeRoute`, which reads Oxy's own model,
 * revision, price-version and scorecard tables — those tables serve the old edge
 * (`api.oxy.so/v1`) and its `/v1/models` until phase 5 deletes them, and a guard
 * test (`kaanaGrantCatalogueGuard.test.ts`) fails if this path, the grant, or
 * the settlement reaches them.
 *
 * ## What is still Oxy's
 *
 *  - The application's POLICY (`RoutingConstraints`: providers, regions, data
 *    controls, licences, price caps), the allowed power levels and the limits.
 *    They are the customer's, and they are read where they always were.
 *  - Whether a route may be SOLD: `inference_deployments`, read by Kaana's
 *    `internal_route_id` only — permission state, status and availability
 *    scope. No model, revision, price or score is joined: a deployment Oxy
 *    has not approved for the viewer's audience is not offered, a deployment
 *    Kaana does not publish does not exist. This is the one legacy table the
 *    path still touches, for the commercial permission ADR 0002 leaves to
 *    «the signed inventory and Oxy's grant»; it goes with the rest in phase 5.
 *
 * ## What it does not do
 *
 *  - It ranks nothing. Scorecards, funding classes and optimisation targets
 *    were Oxy's selection of ONE route; the grant admits a set of providers
 *    and Kaana selects (ADR 0001, decision 3). Routes are listed in a fixed
 *    order (provider, then deployment id) so a grant is reproducible.
 *  - It admits no customer-key (BYOK) route. The platform fee a BYOK request
 *    owes is Oxy's own price, not a model's list price, and a BYOK-only model
 *    declares none: «una concesión para un modelo sin `pricing` declarado no se
 *    puede tasar por unidad». Such a request is refused, never priced at zero.
 *  - It validates no revision. The declared catalogue names a model, not its
 *    revisions; a pinned `@revision` is held to the deployments Kaana
 *    publishes for it.
 */

import { and, inArray } from 'drizzle-orm';
import type { DeclaredModel } from '@kaana.ai/contracts/internal';
import type { UsageUnit } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import {
  inferenceDeployments,
  NORMALIZED_INFERENCE_DEPLOYMENT_AVAILABILITY_SCOPE,
} from '../db/schema/inferenceDeployments';
import {
  type CandidatePrice,
  type CatalogueViewer,
  type EdgeCapacityRequirement,
  type EdgeModalityRequirement,
  type RoutingConstraint,
  type RoutingConstraints,
  capabilityAdmits,
  selectableDeploymentWhere,
  violatedConstraints,
} from './inferenceCatalogue.service';
import type { PriceSnapshotInput } from './inferenceLedger.service';
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

/** One deployment a grant may let Kaana choose. */
export interface GrantRoute {
  /** Kaana's exact deployment id (`internal_route_id`). */
  readonly deploymentId: string;
  /** `publisher/model@revision`, as Kaana's inventory names it. */
  readonly modelReference: string;
  readonly provider: string;
  readonly regions: readonly string[];
  readonly availabilityScope: string;
}

/** A model line the grant can admit: the declared model, its list, its routes. */
export interface GrantLine {
  readonly modelLine: string;
  readonly model: DeclaredModel;
  /** The list this line is rated at, as Kaana declared it. */
  readonly price: PriceSnapshotInput;
  /** At least one, in (provider, deployment id) order, after the application's policy. */
  readonly routes: readonly GrantRoute[];
  /** The line's ceilings, from its declared capabilities. */
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

export type GrantLineResolution =
  | { readonly status: 'resolved'; readonly line: GrantLine }
  | { readonly status: 'unknown-model'; readonly modelReference: string }
  | {
      readonly status: 'model-not-priced';
      readonly modelReference: string;
      readonly error: DeclaredPriceError;
    }
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

/** The deployments Oxy has approved to sell to this audience, by Kaana's deployment id. */
async function sellableDeployments(
  viewer: CatalogueViewer,
  deploymentIds: readonly string[],
): Promise<
  ReadonlyMap<string, { provider: string; availabilityScope: string; dedicated: boolean }>
> {
  if (deploymentIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      deploymentId: inferenceDeployments.internalRouteId,
      provider: inferenceDeployments.providerSlug,
      availabilityScope: NORMALIZED_INFERENCE_DEPLOYMENT_AVAILABILITY_SCOPE,
      dedicated: inferenceDeployments.dedicatedCapacity,
    })
    .from(inferenceDeployments)
    .where(
      and(
        selectableDeploymentWhere(viewer),
        inArray(inferenceDeployments.internalRouteId, [...deploymentIds]),
      ),
    );
  const sellable = new Map<
    string,
    { provider: string; availabilityScope: string; dedicated: boolean }
  >();
  for (const row of rows) {
    if (row.deploymentId === null || row.availabilityScope === 'byok_only') continue;
    sellable.set(row.deploymentId, {
      provider: row.provider,
      availabilityScope: row.availabilityScope,
      dedicated: row.dedicated,
    });
  }
  return sellable;
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
 * of them is theirs to fix; a list that cannot price is refused before routes
 * are looked at, so an unpriced model is never a policy question.
 */
export async function resolveGrantLine(
  evidence: GrantRoutingEvidence,
  viewer: CatalogueViewer,
  modelReference: string,
  constraints: RoutingConstraints,
  modality: EdgeModalityRequirement,
  capacity: EdgeCapacityRequirement,
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

  const outputTokens =
    capacity.outputTokens === 'model-maximum'
      ? capabilities.maxOutputTokens
      : capacity.outputTokens;
  if (
    capabilities.maxOutputTokens < outputTokens ||
    capabilities.maxContextTokens < capacity.inputTokens + outputTokens
  ) {
    const explicit = capacity.outputTokens === 'model-maximum' ? undefined : capacity.outputTokens;
    return {
      status: 'capacity-unavailable',
      modelReference,
      outputLimitExceeded: explicit !== undefined && capabilities.maxOutputTokens < explicit,
      contextLimitExceeded: capabilities.maxContextTokens < capacity.inputTokens + outputTokens,
    };
  }

  let price: PriceSnapshotInput;
  try {
    price = requirePriceSnapshot(evidence.catalogue, model);
  } catch (error) {
    if (error instanceof DeclaredPriceError) {
      return { status: 'model-not-priced', modelReference, error };
    }
    throw error;
  }

  // The routes Kaana publishes for this line (and revision, when pinned) that
  // Oxy has approved to sell to this audience.
  const published = [...evidence.published.values()].filter((route) => {
    const reference = splitReference(route.modelReference);
    return (
      reference.modelId === modelId && (revision === undefined || reference.revision === revision)
    );
  });
  const sellable = await sellableDeployments(
    viewer,
    published.map((route) => route.deploymentId),
  );
  const candidates: (GrantRoute & { readonly dedicated: boolean })[] = [];
  for (const route of published) {
    const approved = sellable.get(route.deploymentId);
    // Oxy's row and Kaana's descriptor must name the same provider: two
    // identities for one deployment id is not a route either side vouches for.
    if (approved === undefined || approved.provider !== route.provider) continue;
    candidates.push({
      deploymentId: route.deploymentId,
      modelReference: route.modelReference,
      provider: route.provider,
      regions: route.regions,
      availabilityScope: approved.availabilityScope,
      dedicated: approved.dedicated,
    });
  }
  if (candidates.length === 0) return { status: 'no-published-route', modelReference };

  // The application's policy, over the declared facts: licence and data policy
  // are the MODEL's (declared by Kaana), regions and provider the ROUTE's, the
  // price caps compare against the declared list.
  const candidatePrice: CandidatePrice = {
    currency: price.currency,
    unitPrices: price.unitPrices.map((entry) => ({
      unit: entry.unit as UsageUnit,
      amount: entry.amount,
      per: entry.per,
    })),
  };
  const kept: GrantRoute[] = [];
  const excludedBy: RoutingConstraint[] = [];
  for (const candidate of candidates) {
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
        dedicatedCapacity: candidate.dedicated,
        licenseId: model.license.licenseId,
        commercialUseAllowed: model.license.commercialUseAllowed,
        priceVersionId: price.priceVersionId,
      },
      candidatePrice,
    );
    if (violated.length === 0) {
      const { dedicated: _dedicated, ...route } = candidate;
      kept.push(route);
      continue;
    }
    for (const constraint of violated) {
      if (!excludedBy.includes(constraint)) excludedBy.push(constraint);
    }
  }
  if (kept.length === 0) {
    return { status: 'policy-excluded', modelReference, constraints: excludedBy };
  }

  return {
    status: 'resolved',
    line: {
      modelLine: modelId,
      model,
      price,
      routes: kept.sort(compareRoutes),
      maxContextTokens: capabilities.maxContextTokens,
      maxOutputTokens: capabilities.maxOutputTokens,
    },
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
