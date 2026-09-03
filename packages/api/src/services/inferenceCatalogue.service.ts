/**
 * The canonical model catalogue — reads, the serving boundary, and the
 * commercial-permission gate.
 *
 * Issue #972, workstreams 5 and 11. Decided in
 * `docs/adr/0008-catalogue-concept-separation.md`; the wire shapes are
 * `@oxyhq/contracts`' `inference/catalogue.ts`.
 *
 * Four things live here and nowhere else:
 *
 *  1. **The audience.** {@link resolveCatalogueViewer} turns an authenticated
 *     principal into the set of availability scopes it may see. Default deny:
 *     an unrecognised principal gets the public set, and two scopes are
 *     currently ungrantable to anybody at all — see {@link UNGRANTABLE_SCOPES}.
 *  2. **The one selectability predicate.** {@link selectableDeploymentWhere} is
 *     the ONLY place a route is decided to be offerable. There is deliberately
 *     no "internal routes are exempt" branch: an internal route needs the same
 *     approved permission state as a public one, because an exemption is where
 *     a gate silently widens.
 *  3. **The customer's own routing policy, applied to the candidates.**
 *     {@link violatedConstraints} is the ONLY place a policy control meets a
 *     route. Selectability answers "may Oxy offer this at all"; a policy answers
 *     "may this customer be served by it", and the two are different questions —
 *     which is why a candidate excluded by a policy is reported as its own
 *     outcome naming the control, never collapsed into "no such model" and
 *     never widened back to a route the policy forbade (issue #1011).
 *  4. **The customer-safe projection.** The serializer's INPUT TYPE is derived
 *     from an explicit allow-list of columns, so the internal route id and the
 *     upstream wholesale cost are not properties it can read — reading one is a
 *     `tsc` error, not a review comment. Default deny in the other direction
 *     too: a column added to `inference_deployments` tomorrow is invisible to
 *     customers until somebody names it here, and
 *     `schema/__tests__/inferenceCatalogue.test.ts` fails until somebody
 *     classifies it either way.
 *
 * Kaana remains the source of technical deployment health and route
 * availability (ADR 0006). Nothing here reports whether a route is answering
 * right now; `status` is the catalogue's own decision about whether a route may
 * be OFFERED, which is a different question. Collapsing the two is what the
 * retired `models-stats.ts` did with its literal `isHealthy: true`.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  AuthorizedRoute,
  AvailabilityScope,
  InferenceEnvironment,
  ModelCatalogueEntry,
  PriceSnapshot,
  RoutingPolicy,
  RoutingProfile,
  UnitPrice,
  UsageUnit,
} from '@oxyhq/contracts';
import {
  INFERENCE_MONEY_SCALE,
  modelCatalogueEntrySchema,
  priceSnapshotSchema,
  routingProfileSchema,
} from '@oxyhq/contracts';
import type { SelectedRow } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import {
  inferenceDeployments,
  inferenceDeploymentRoutingScores,
  inferenceModelEvaluations,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
  priceVersions,
  priceVersionUnitPrices,
  SELECTABLE_PERMISSION_STATE,
} from '../db/schema';
import type { InferenceModalityValue } from '../db/schema/inferenceModels';
import {
  classifyApplicationTier,
  type ApplicationClassification,
} from '../utils/applicationTier';
import { resolveProviderConnectionForApplication } from './inferenceProviderConnection.service';

/* -------------------------------------------------------------------------- */
/*  1. The audience                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Who is asking, expressed as the availability scopes they may be served.
 *
 * A set rather than a single scope because one caller legitimately sees several
 * — an ordinary customer sees both the public pay-as-you-go routes and the
 * Oxy-hosted ones. `label` exists for logs and for a test's own readability and
 * is NEVER read by an authorization decision.
 */
export interface CatalogueViewer {
  readonly scopes: readonly AvailabilityScope[];
  readonly label: string;
}

/**
 * What an ordinary external customer sees.
 *
 * `public_payg` is the pay-as-you-go catalogue; `oxy_hosted` is how open-weight
 * models Oxy runs itself are offered, and is equally customer-selectable. Both
 * still require an approved permission state — this set decides the AUDIENCE,
 * never the approval.
 */
export const PUBLIC_CATALOGUE_SCOPES: readonly AvailabilityScope[] = ['public_payg', 'oxy_hosted'];

/**
 * Scopes NO principal can be granted today, and why each one is not merely
 * forgotten.
 *
 * Writing them down is the point: a scope silently missing from every viewer
 * and a scope deliberately withheld look identical from the outside, and the
 * difference decides whether the next person adds it by hand.
 *
 * - `enterprise` needs a per-account entitlement, which is the billing
 *   workstream's (7) to define. Granting it on the strength of "the account
 *   looks big" would be a commercial decision made by a heuristic.
 * - `byok_only` is never a public catalogue entitlement. The authenticated
 *   edge considers it request-locally only after it has the exact application
 *   and environment needed to resolve a ready, active, valid connection.
 *
 * `schema/__tests__`/the service tests assert no catalogue viewer produces
 * either. The edge's separate authenticated widening does not alter that.
 */
export const UNGRANTABLE_SCOPES: readonly AvailabilityScope[] = ['enterprise', 'byok_only'];

/** The viewer for an unauthenticated or ordinary customer request. */
export const PUBLIC_CATALOGUE_VIEWER: CatalogueViewer = {
  scopes: PUBLIC_CATALOGUE_SCOPES,
  label: 'public',
};

/**
 * Whether a viewer sees no more than the public audience does.
 *
 * Read by the rollout's publication gate (`routes/inferenceCatalogue.ts`), which
 * withholds the catalogue from public viewers before launch. Structural rather
 * than a reference comparison against {@link PUBLIC_CATALOGUE_VIEWER} or a
 * `label` test: both of those answer "internal" — the permissive direction — the
 * moment a viewer is built as a structurally equal copy, and `label` is
 * explicitly not an authorization input. Widening the internal viewer's scopes
 * keeps this correct; it can only ever make a privileged viewer non-public.
 */
export function isPublicCatalogueViewer(viewer: CatalogueViewer): boolean {
  return viewer.scopes.every((scope) => PUBLIC_CATALOGUE_SCOPES.includes(scope));
}

/** The subset of an `Application` row this decision reads. */
export type CatalogueApplicationPrincipal = ApplicationClassification;

/**
 * Turn an authenticated principal into a viewer.
 *
 * `undefined` — no application principal at all, i.e. an anonymous caller or a
 * plain user bearer — resolves to the PUBLIC viewer, not to a privileged one.
 * That is the default-deny direction: the way to see more is to present an
 * internal application credential, never to present nothing.
 *
 * `platform_internal` is available to staff-controlled first-party, internal
 * and system applications. That is an audience boundary, not a resale claim:
 * third-party applications and plain user bearers remain on the public scopes.
 * The exact tier still comes from `classifyApplicationTier`, shared with the
 * inference edge's rollout gate, so catalogue and execution cannot classify the
 * same application differently.
 */
export function resolveCatalogueViewer(
  application: CatalogueApplicationPrincipal | undefined
): CatalogueViewer {
  const tier = classifyApplicationTier(application);
  if (tier === 'third_party') return PUBLIC_CATALOGUE_VIEWER;

  return {
    scopes: [...PUBLIC_CATALOGUE_SCOPES, 'platform_internal'],
    label: tier,
  };
}

/* -------------------------------------------------------------------------- */
/*  2. The one selectability predicate                                        */
/* -------------------------------------------------------------------------- */

/**
 * Catalogue statuses under which a route may still be offered.
 *
 * `degraded` is included: it means "offer it with a warning", not "it is timing
 * out" — which is Kaana's signal, and not stored here. `disabled` and `retired`
 * are never offered.
 */
const OFFERABLE_STATUSES = ['active', 'degraded'] as const;

/**
 * The ONE predicate that decides whether a route may be offered to a viewer.
 *
 * Every read below funnels through it, so there is exactly one place to audit
 * and exactly one place a widening could happen.
 *
 * All three conditions are required, and the permission one has no exemption:
 * a `platform_internal` route with `permission_state = 'pending_review'` is
 * invisible to every official product too. That costs one staff approval per
 * platform route and buys a gate with no branch in it.
 */
function selectableDeploymentWhere(viewer: CatalogueViewer) {
  return and(
    inArray(inferenceDeployments.availabilityScope, [...viewer.scopes]),
    eq(inferenceDeployments.permissionState, SELECTABLE_PERMISSION_STATE),
    inArray(inferenceDeployments.status, [...OFFERABLE_STATUSES])
  );
}

/* -------------------------------------------------------------------------- */
/*  3. The customer's own routing policy, applied to the candidates           */
/* -------------------------------------------------------------------------- */

/**
 * The routing-policy controls a candidate route is filtered on.
 *
 * A `Pick` of the CONTRACT's own {@link RoutingPolicy} rather than a shape
 * restated here, so the name a refusal reports IS the name of the field in the
 * customer's own policy, and renaming a control upstream fails `tsc` here
 * instead of quietly detaching the filter from the thing it enforces.
 *
 * What is absent from this list is as deliberate as what is in it — see
 * {@link UNFILTERED_ROUTING_CONTROLS}, which names every remaining control with
 * the reason, and {@link EVERY_ROUTING_CONTROL_IS_CLASSIFIED}, which fails the
 * build if a control ever ends up in neither list.
 */
export type RoutingConstraints = Pick<
  RoutingPolicy,
  | 'requireZeroDataRetention'
  | 'prohibitTrainingOnCustomerData'
  | 'requireCommercialUseRights'
  | 'allowedLicenseIds'
  | 'providerAllowlist'
  | 'providerDenylist'
  | 'allowedRegions'
  | 'deniedRegions'
  | 'oxyHostedOnly'
  | 'byokPreference'
  | 'dedicatedCapacity'
  | 'maxPricePerUnit'
  | 'maxPricePerRequest'
>;

/**
 * Which control excluded a candidate — always the customer's own field name.
 *
 * Derived from {@link RoutingConstraints} rather than written out as a second
 * list, because a refusal that names a control the customer cannot find in
 * their own policy is a refusal they cannot act on.
 */
export type RoutingConstraint = keyof RoutingConstraints;

/**
 * Every remaining control of `routingPolicySchema`, and why this filter does
 * not evaluate it.
 *
 * The other half of the classification, kept beside the enforced list so the
 * pair reads as one decision — the same shape as
 * {@link CUSTOMER_SAFE_DEPLOYMENT_COLUMNS} and
 * {@link INTERNAL_DEPLOYMENT_COLUMNS} below. Silence is what let three controls
 * be stored, versioned, pinned onto a receipt and never read (issue #1011); a
 * control named here is one somebody decided about.
 *
 * Being named here is not a resting place. `maxPricePerUnit` and
 * `maxPricePerRequest` sat here as INERT — honestly, with a reason — until the
 * price comparison in {@link violatedConstraints} landed, and the entries left
 * with it, in the same change. A control that is enforced while still named here
 * is worse than either state on its own, because the next reader trusts the
 * list.
 */
export const UNFILTERED_ROUTING_CONTROLS = {
  schemaVersion: 'The wire shape’s version, not a customer control.',
  routingPolicyId: 'The policy’s identity. Recorded on the envelope and the receipt, never matched against a route.',
  policyVersion: 'The customer’s own revision number. Same.',
  scope: 'Which account or application the policy governs — already resolved before a route is looked for.',
  updatedAt: 'When the version was written.',
  defaultTarget:
    'ENFORCED, but at the edge rather than here: it decides WHICH model reference is resolved when the caller named none (`inferenceEdge.service.ts`), so it is an input to this resolution and never a filter over its candidates.',
  fallback:
    'ENFORCED, in two places and never here: `inferenceEdge.service.ts` decides from `fallback.disabled`/`sameModelDeployment` whether the envelope’s `authorizedRoutes` carries any failover destination at all (ADR 0017), and `inferenceRoutingPolicy.service.ts`’s `recordRouteSwitch` refuses to record a substitution whose destination is not named in the version’s authorisation rows. It governs a SWITCH between routes, not the qualification of one, so it cannot be expressed as a predicate over a single candidate — which is why `resolveEdgeRoute` returns every survivor and the edge, not this filter, applies it.',
  optimiseFor:
    'ENFORCED by the edge resolver as a ranking over reviewed scorecards after every filtering control has qualified the candidate. It never excludes a policy-conforming route; unavailable or stale ranking evidence makes the complete route set unavailable before reservation.',
} as const satisfies Readonly<Partial<Record<keyof RoutingPolicy, string>>>;

/** A control of `routingPolicySchema` that is in neither list. */
type UnclassifiedRoutingControl = Exclude<
  keyof RoutingPolicy,
  RoutingConstraint | keyof typeof UNFILTERED_ROUTING_CONTROLS
>;

/**
 * `true` exactly when every control of `routingPolicySchema` is either enforced
 * by {@link violatedConstraints} or named in {@link UNFILTERED_ROUTING_CONTROLS}.
 *
 * A gate in the TYPE SYSTEM for a property the type system owns: add a control
 * to the contract and name it in neither list, and this annotation resolves to
 * the NAME of that control instead of `true`, so the assignment fails `tsc`
 * before any test runs and the error reads
 * `Type 'true' is not assignable to type '"optimiseFor"'`. The false branch is
 * the leftover union rather than a bare `false` for exactly that reason — a
 * `false` fails too, but leaves the reader to find out which control did it. A
 * `Pick` alone would have ignored the new control silently, which is the failure
 * mode issue #1011 is a report of.
 */
export const EVERY_ROUTING_CONTROL_IS_CLASSIFIED: [UnclassifiedRoutingControl] extends [never]
  ? true
  : UnclassifiedRoutingControl = true;

/**
 * The constraints a request is served under when its application has configured
 * NO routing policy at all.
 *
 * A NAMED value rather than an optional argument, and that is the whole point:
 * `resolveEdgeRoute` and {@link selectRouteForViewer} both REQUIRE constraints,
 * so "this request is unconstrained" is a sentence somebody had to write, not an
 * argument somebody forgot. An optional parameter defaulting to this would
 * restore exactly the silence issue #1011 describes.
 *
 * The two enums have no "unset" member, so their neutral value is `'disabled'`,
 * which reads as a prohibition — see {@link violatedConstraints}. Neither
 * prohibition can withhold a route from an unconstrained/public catalogue read:
 * `byok_only` is in {@link UNGRANTABLE_SCOPES} there, and a deployment with
 * `dedicated_capacity` holds capacity reserved for ONE enterprise account, which
 * an application with no policy of its own was never entitled to.
 *
 * `maxPricePerRequest` is written out as an explicit `undefined` even though the
 * contract makes it OPTIONAL. It is the only control `tsc` would let a writer
 * omit here silently, and "no ceiling on the whole request" is exactly the kind
 * of permission that must be stated rather than inherited from a missing key.
 * The runtime half of that gate is `__tests__`, which reads the enforced control
 * set off `Object.keys(UNCONSTRAINED_ROUTING)` — a key absent here would drop
 * out of that census too.
 */
export const UNCONSTRAINED_ROUTING: RoutingConstraints = {
  requireZeroDataRetention: false,
  prohibitTrainingOnCustomerData: false,
  requireCommercialUseRights: false,
  allowedLicenseIds: [],
  providerAllowlist: [],
  providerDenylist: [],
  allowedRegions: [],
  deniedRegions: [],
  oxyHostedOnly: false,
  byokPreference: 'disabled',
  dedicatedCapacity: 'disabled',
  maxPricePerUnit: [],
  maxPricePerRequest: undefined,
};

/**
 * The constraints a stored policy imposes.
 *
 * Copied field by field rather than spread, so a control added to
 * {@link RoutingConstraints} fails `tsc` here until somebody supplies it — a
 * spread would compile with the new control silently absent.
 */
export function routingConstraintsOf(policy: RoutingPolicy): RoutingConstraints {
  return {
    requireZeroDataRetention: policy.requireZeroDataRetention,
    prohibitTrainingOnCustomerData: policy.prohibitTrainingOnCustomerData,
    requireCommercialUseRights: policy.requireCommercialUseRights,
    allowedLicenseIds: policy.allowedLicenseIds,
    providerAllowlist: policy.providerAllowlist,
    providerDenylist: policy.providerDenylist,
    allowedRegions: policy.allowedRegions,
    deniedRegions: policy.deniedRegions,
    oxyHostedOnly: policy.oxyHostedOnly,
    byokPreference: policy.byokPreference,
    dedicatedCapacity: policy.dedicatedCapacity,
    maxPricePerUnit: policy.maxPricePerUnit,
    maxPricePerRequest: policy.maxPricePerRequest,
  };
}

/** Everything about one candidate route a routing constraint is evaluated against. */
export interface ConstrainedCandidate {
  readonly providerSlug: string;
  readonly availabilityScope: string;
  readonly regions: readonly string[];
  readonly retainsPayloads: boolean;
  readonly retentionDays: number;
  readonly trainsOnCustomerData: boolean;
  readonly zeroDataRetentionAvailable: boolean;
  readonly dedicatedCapacity: boolean;
  /** From `inference_models`: a licence is a property of the model, not the route. */
  readonly licenseId: string;
  readonly commercialUseAllowed: boolean;
  /**
   * The price version this route is quoted, held and settled at — `null` when
   * Oxy has published no price for it at all.
   *
   * A KEY, not a price: {@link applyRoutingConstraints} resolves it to the
   * published amounts once for the whole candidate set, because a price lives in
   * a child table of another table and cannot ride along as a column without
   * multiplying the candidate rows.
   */
  readonly priceVersionId: string | null;
}

/**
 * Every column {@link violatedConstraints} reads, as ONE selection object.
 *
 * Shared by both resolvers so they cannot disagree about what a constraint is
 * evaluated against — two selections would be two places a column could be left
 * out, and a missing column reads as `undefined`, which most of these
 * comparisons would treat as "qualifies".
 */
const CONSTRAINT_COLUMNS = {
  providerSlug: inferenceDeployments.providerSlug,
  availabilityScope: inferenceDeployments.availabilityScope,
  regions: inferenceDeployments.regions,
  retainsPayloads: inferenceDeployments.retainsPayloads,
  retentionDays: inferenceDeployments.retentionDays,
  trainsOnCustomerData: inferenceDeployments.trainsOnCustomerData,
  zeroDataRetentionAvailable: inferenceDeployments.zeroDataRetentionAvailable,
  dedicatedCapacity: inferenceDeployments.dedicatedCapacity,
  licenseId: inferenceModels.licenseId,
  commercialUseAllowed: inferenceModels.commercialUseAllowed,
  // The price CEILINGS are evaluated against the version this route is actually
  // charged at, so the key belongs in the shared selection like every other
  // constraint input. BYOK uses only its separately reviewed platform-fee
  // version; its provider price remains NULL because the provider bills the
  // customer directly. It stays out of `CUSTOMER_SAFE_DEPLOYMENT_COLUMNS`: what
  // a customer is shown is the price snapshot it resolves to, never the key.
  priceVersionId: sql<string | null>`case
    when ${inferenceDeployments.availabilityScope} = 'byok_only'
      then ${inferenceDeployments.platformFeePriceVersionId}
    else ${inferenceDeployments.priceVersionId}
  end`,
} as const;

/**
 * One unit's price, exactly as a published price version quotes it: `amount` per
 * `per` units.
 *
 * `amount` is the exact decimal STRING the `numeric(30, 12)` column holds. It is
 * never parsed into a JS `number` anywhere below — see {@link exceedsRate}.
 */
export interface CandidateUnitPrice {
  readonly unit: UsageUnit;
  readonly amount: string;
  /** How many units `amount` buys. Positive, by the table's own CHECK. */
  readonly per: number;
}

/**
 * What one candidate route charges, read from the price version its deployment
 * row names.
 *
 * A unit ABSENT from `unitPrices` is not an unknown price: a published version is
 * a complete statement of what the route charges for, so an absent unit is a unit
 * the route does not charge for. What is unknown is a route with no version at
 * all, and that is carried by the ABSENCE of a whole {@link CandidatePrice} —
 * which {@link violatedConstraints} treats as a ceiling it cannot satisfy.
 */
export interface CandidatePrice {
  readonly currency: string;
  /** Ordered by unit, so a price is read the same way twice. */
  readonly unitPrices: readonly CandidateUnitPrice[];
}

/**
 * The published prices of a set of price versions, keyed by version id.
 *
 * ONE query for the whole set, with a LEFT JOIN rather than an inner one: a
 * version with no unit-price rows must still resolve — to its currency and an
 * EMPTY price list — because "this route publishes a price and charges for
 * nothing" and "this route publishes no price" are different facts and only the
 * second one defeats a ceiling.
 *
 * No `status` filter, deliberately. Settlement prices a receipt with whatever
 * version it is handed (`inferenceLedger.service.ts`'s `computeCharge`), so a
 * ceiling has to be compared against the same row — filtering to `active` here
 * would compare against a price the request will not be charged at, which is a
 * ceiling that passes while the customer is billed more.
 */
async function loadCandidatePrices(
  priceVersionIds: readonly string[]
): Promise<ReadonlyMap<string, CandidatePrice>> {
  if (priceVersionIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      priceVersionId: priceVersions.id,
      currency: priceVersions.currency,
      unit: priceVersionUnitPrices.unit,
      amount: priceVersionUnitPrices.amount,
      per: priceVersionUnitPrices.per,
    })
    .from(priceVersions)
    .leftJoin(
      priceVersionUnitPrices,
      eq(priceVersionUnitPrices.priceVersionId, priceVersions.id)
    )
    .where(inArray(priceVersions.id, [...priceVersionIds]))
    .orderBy(asc(priceVersions.id), asc(priceVersionUnitPrices.unit));

  const prices = new Map<string, { currency: string; unitPrices: CandidateUnitPrice[] }>();
  for (const row of rows) {
    const price = prices.get(row.priceVersionId) ?? {
      currency: row.currency,
      unitPrices: [],
    };
    // The LEFT JOIN's absent side. Narrowed on all three columns rather than on
    // `unit` alone, so the entry pushed below is complete by construction and
    // needs no assertion.
    if (row.unit !== null && row.amount !== null && row.per !== null) {
      price.unitPrices.push({ unit: row.unit, amount: row.amount, per: row.per });
    }
    prices.set(row.priceVersionId, price);
  }

  return prices;
}

/**
 * An exact decimal amount as an INTEGER scaled by {@link INFERENCE_MONEY_SCALE}.
 *
 * A shift of the decimal point, expressed as a digit-string concatenation — the
 * same technique `utils/minorUnits.ts` uses, and for the same reason: `Number`
 * cannot hold these values and a float amount is wrong by construction. A
 * `bigint` is an exact integer of unbounded width, so a product of two of them
 * loses nothing. (No `bigint` LITERAL appears anywhere here: this package
 * compiles at `target: es6`, where a literal is a compile error while `BigInt(…)`
 * and bigint arithmetic are not — measured, not assumed.)
 *
 * Throws rather than admitting a malformed amount. Every value reaching this
 * comes from a `numeric(_, INFERENCE_MONEY_SCALE)` column with a `>= 0` CHECK, or
 * from `exactDecimalSchema`, so a failure means the ledger's own schema disagrees
 * with the money contract — the same stance `loadPriceSnapshots` takes on a
 * malformed snapshot, and for the same reason: the alternatives are to admit a
 * route whose price is unreadable or to exclude one whose price is fine, and both
 * are silent.
 */
function scaledAmount(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (match === null) {
    throw new Error(`not an exact non-negative decimal amount: ${amount}`);
  }
  const [, integerDigits, fractionDigits = ''] = match;
  if (fractionDigits.length > INFERENCE_MONEY_SCALE) {
    throw new Error(
      `amount ${amount} carries more than ${INFERENCE_MONEY_SCALE} fractional digits`
    );
  }
  return BigInt(integerDigits + fractionDigits.padEnd(INFERENCE_MONEY_SCALE, '0'));
}

/**
 * Whether `rate` is strictly more expensive than `ceiling`, both quoted as an
 * exact `amount` per `per` units.
 *
 * CROSS-MULTIPLIED, never divided: `amount / per` is a repeating decimal for most
 * `per` (a price of `1` per `3` units is `0.333…`), so any comparison that
 * divides first has to round, and a rounded comparison admits a route that is
 * over the ceiling by less than the rounding. Two exact integer products have no
 * such boundary.
 *
 * STRICTLY greater, so a price exactly AT the ceiling is admitted — a ceiling the
 * customer wrote as "at most X" that refused X would be a ceiling nobody could
 * set on the price they actually see quoted.
 */
function exceedsRate(
  rate: { readonly amount: string; readonly per: number },
  ceiling: { readonly amount: string; readonly per: number }
): boolean {
  return (
    scaledAmount(rate.amount) * BigInt(ceiling.per) >
    scaledAmount(ceiling.amount) * BigInt(rate.per)
  );
}

/**
 * Whether `amount` is strictly greater than `other`, both exact decimals at
 * `INFERENCE_MONEY_SCALE`.
 *
 * Exported, and living here beside {@link exceedsRate} rather than where it is
 * used: it is the same comparison over the same scale and the same
 * {@link scaledAmount}, and a second implementation of "which of these two exact
 * decimals is larger" would be a second place the money scale can be got wrong —
 * silently, because both answers look plausible.
 *
 * The caller is the edge, sizing one hold against the most expensive route it
 * authorizes (ADR 0017). A `number` comparison would be the failure this whole
 * file avoids: `numeric(30, 12)` does not survive an IEEE double.
 */
export function exceedsAmount(amount: string, other: string): boolean {
  return scaledAmount(amount) > scaledAmount(other);
}

/**
 * Whether a candidate's price breaks ONE per-unit ceiling.
 *
 * The three answers, in the order they are decided and for reasons that differ:
 *
 *  1. **No published price at all ⇒ EXCLUDED.** A ceiling is a promise about what
 *     the customer will be charged, and a route that publishes no price cannot be
 *     shown to keep it. This is the direction that matters: admitting it would
 *     turn every ceiling off for exactly the routes Oxy has described least. A
 *     customer with a ceiling therefore hears `policy_violation` naming their own
 *     control for an unpriced route. Without a ceiling, the route reaches the
 *     complete-envelope evidence check and fails closed as `missing-price`.
 *  2. **The version does not price this unit ⇒ ADMITTED.** Checked BEFORE the
 *     currency, because there is nothing to compare and therefore no currency
 *     question. A published version is a complete statement of what a route
 *     charges for, so an absent unit means the customer is never billed for it and
 *     the ceiling is trivially kept. Reading it as "unknown, refuse" would give
 *     the control a second, unstated meaning — "this unit MUST be priced" — and
 *     would exclude every text route for a customer who defensively capped
 *     `video_milliseconds`. The genuinely dangerous case, a unit that IS metered
 *     with no price to charge it at, belongs to settlement and is already refused
 *     there rather than undercharged (`computeCharge`'s `unpricedUnits`).
 *  3. **A different currency ⇒ EXCLUDED, never converted.** There is no
 *     exchange-rate authority anywhere in this system, so a EUR price and a USD
 *     ceiling are not comparable and coercing them would produce a number that is
 *     not money. The ceilings cannot disagree among THEMSELVES — one currency
 *     column on the version row carries all of them — so this can only ever be a
 *     route priced in a currency the customer's policy does not speak.
 */
function exceedsUnitCeiling(ceiling: UnitPrice, price: CandidatePrice | undefined): boolean {
  if (price === undefined) return true;

  const priced = price.unitPrices.find((unitPrice) => unitPrice.unit === ceiling.unit);
  if (priced === undefined) return false;

  if (price.currency !== ceiling.currency) return true;

  return exceedsRate(priced, ceiling);
}

/**
 * Whether a candidate's UNAVOIDABLE per-request fee alone breaks the ceiling on a
 * whole request.
 *
 * ## What is enforced here, and what is not
 *
 * A request's total cost depends on the request's own metered quantities, which do
 * not exist yet when a route is chosen — so the whole of `maxPricePerRequest`
 * cannot be a predicate over a candidate. What CAN be: the `requests` unit is a
 * FLAT fee charged once per request whatever the quantities turn out to be, so a
 * route whose flat fee already exceeds the ceiling can never serve a request
 * within it, for any request. That is a sound exclusion and it is the half
 * enforced here.
 *
 * The other half — comparing the maximum quoted cost of THIS request, sized from
 * its own input and output ceiling — is enforced at the edge beside the exact
 * quote (`inferenceEdge.service.ts`). This early predicate is intentionally only
 * the cheap, request-independent exclusion: the edge remains the authority for
 * the complete `maxPricePerRequest` decision before reservation or forwarding.
 *
 * Otherwise the same three answers, in the same order and for the same reasons,
 * as {@link exceedsUnitCeiling} — including "no published price at all" excluding
 * the route. The ceiling is a rate of `amount` per ONE request, which is what
 * makes it comparable to the flat fee at all.
 */
function exceedsRequestCeiling(
  ceiling: { readonly amount: string; readonly currency: string },
  price: CandidatePrice | undefined
): boolean {
  if (price === undefined) return true;

  const perRequest = price.unitPrices.find((unitPrice) => unitPrice.unit === 'requests');
  if (perRequest === undefined) return false;

  if (price.currency !== ceiling.currency) return true;

  return exceedsRate(perRequest, { amount: ceiling.amount, per: 1 });
}

/**
 * Which of a policy's constraints this candidate fails — ALL of them, in the
 * order written below, so a refusal can say what would have to change.
 *
 * Every list-valued control has an EXPLICIT empty branch rather than a bare
 * containment test: `[].includes(x)` is false for every `x`, so an empty
 * allow-list written as plain membership would exclude every candidate, which is
 * the opposite of the contract's "empty means no allowlist".
 *
 * `price` is a REQUIRED third argument, `undefined` meaning "this route publishes
 * no price at all" — the same discipline `constraints` itself is held to on the
 * resolvers. It is a value the caller must state, because the two price ceilings
 * cannot be read off a deployment column: a price lives in a child table of
 * `price_versions`, and {@link applyRoutingConstraints} resolves it for the whole
 * candidate set before calling this. An OPTIONAL parameter would let a caller
 * omit the price and get "every ceiling refuses everything", which is the same
 * class of silence as the value-available-and-not-passed shape issue #1011 was.
 */
export function violatedConstraints(
  constraints: RoutingConstraints,
  candidate: ConstrainedCandidate,
  price: CandidatePrice | undefined
): RoutingConstraint[] {
  const violated: RoutingConstraint[] = [];

  // "Zero retention" is a claim about what a route DOES, not only about what it
  // could be asked to do. `zero_data_retention_available` is the CAPABILITY; a
  // route carrying it while still retaining payloads by default would satisfy a
  // capability check and retain the customer's data anyway, and asking for ZDR
  // per request is a data-plane flag that does not exist. So all three columns,
  // which is also why the day count is read rather than inferred from the
  // table's own coherence CHECK.
  if (
    constraints.requireZeroDataRetention &&
    !(
      candidate.zeroDataRetentionAvailable &&
      !candidate.retainsPayloads &&
      candidate.retentionDays === 0
    )
  ) {
    violated.push('requireZeroDataRetention');
  }

  if (constraints.prohibitTrainingOnCustomerData && candidate.trainsOnCustomerData) {
    violated.push('prohibitTrainingOnCustomerData');
  }

  if (constraints.requireCommercialUseRights && !candidate.commercialUseAllowed) {
    violated.push('requireCommercialUseRights');
  }

  if (
    constraints.allowedLicenseIds.length > 0 &&
    !constraints.allowedLicenseIds.includes(candidate.licenseId)
  ) {
    violated.push('allowedLicenseIds');
  }

  if (
    constraints.providerAllowlist.length > 0 &&
    !constraints.providerAllowlist.includes(candidate.providerSlug)
  ) {
    violated.push('providerAllowlist');
  }

  if (constraints.providerDenylist.includes(candidate.providerSlug)) {
    violated.push('providerDenylist');
  }

  // SUBSET, not intersection. A deployment declares every region it MAY serve
  // from and choosing among them is routing execution (ADR 0006), so a route
  // that may run outside the allowed set cannot honour a residency requirement.
  // An empty set means Kaana has not attested a region. It is NOT "global" and
  // cannot satisfy any explicit residency control, including a deny-only one:
  // without an attested location Oxy cannot prove that the denied region is
  // avoided. Unconstrained routing may still use the deployment.
  if (
    constraints.allowedRegions.length > 0 &&
    (candidate.regions.length === 0 ||
      !candidate.regions.every((region) => constraints.allowedRegions.includes(region)))
  ) {
    violated.push('allowedRegions');
  }

  if (
    constraints.deniedRegions.length > 0 &&
    (candidate.regions.length === 0 ||
      candidate.regions.some((region) => constraints.deniedRegions.includes(region)))
  ) {
    violated.push('deniedRegions');
  }

  if (constraints.oxyHostedOnly && candidate.availabilityScope !== 'oxy_hosted') {
    violated.push('oxyHostedOnly');
  }

  // `'prefer'` appears in neither enum below, and its absence is the decision:
  // it is a RANKING among routes that already qualify, so it can never exclude a
  // candidate. `'require'` and `'disabled'` are the two arms a route can fail —
  // "must use the customer's own provider credential" and "must not".
  if (
    (constraints.byokPreference === 'require' && candidate.availabilityScope !== 'byok_only') ||
    (constraints.byokPreference === 'disabled' && candidate.availabilityScope === 'byok_only')
  ) {
    violated.push('byokPreference');
  }

  if (
    (constraints.dedicatedCapacity === 'require' && !candidate.dedicatedCapacity) ||
    (constraints.dedicatedCapacity === 'disabled' && candidate.dedicatedCapacity)
  ) {
    violated.push('dedicatedCapacity');
  }

  // The two price ceilings, last because they are the only controls that read
  // something other than the candidate's own columns. Both compare against the
  // price version the ROUTE names — the one a hold is sized against and the
  // receipt is settled at (`EdgeRoute.priceVersionId`) — and never against
  // whichever version is `active` for this model and provider right now: that is
  // a second resolution, and a ceiling compared against a price the request will
  // not be charged at is a ceiling that passes while the customer is billed more.
  //
  // `.some` over an EMPTY list is `false`, which is precisely the contract's "no
  // ceiling". That is the opposite of the allow-list trap above, where an empty
  // list must not be read as membership — worth stating, because the two empty
  // arrays look identical and mean opposite things.
  if (constraints.maxPricePerUnit.some((ceiling) => exceedsUnitCeiling(ceiling, price))) {
    violated.push('maxPricePerUnit');
  }

  if (
    constraints.maxPricePerRequest !== undefined &&
    exceedsRequestCeiling(constraints.maxPricePerRequest, price)
  ) {
    violated.push('maxPricePerRequest');
  }

  return violated;
}

/** What is left of a candidate set once the policy has been applied to it. */
interface ConstrainedCandidates<T> {
  readonly kept: readonly T[];
  /**
   * Every control that excluded at least one candidate, first occurrence first.
   * Deterministic: candidates arrive ordered by provider slug and each
   * candidate's violations come back in {@link violatedConstraints}' written
   * order. Empty exactly when nothing was excluded.
   */
  readonly excludedBy: readonly RoutingConstraint[];
}

/**
 * Apply a policy to a candidate set, resolving each candidate's published price
 * first.
 *
 * The price load is UNCONDITIONAL — one query, whether or not the policy sets a
 * ceiling — and that is the point: a "skip the query when there are no ceilings"
 * branch would be a second behaviour whose correctness rests on nothing below
 * reading a price it was not given, which is a property that rots the first time
 * somebody adds a control. Both resolvers go through here, so neither can
 * disagree with the other about which version a route is priced at, for the same
 * reason {@link CONSTRAINT_COLUMNS} exists.
 */
async function applyRoutingConstraints<T extends ConstrainedCandidate>(
  constraints: RoutingConstraints,
  candidates: readonly T[]
): Promise<ConstrainedCandidates<T>> {
  const prices = await loadCandidatePrices([
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.priceVersionId === null ? [] : [candidate.priceVersionId]
      )
    ),
  ]);

  const kept: T[] = [];
  const excludedBy: RoutingConstraint[] = [];

  for (const candidate of candidates) {
    // `undefined` on both arms that mean "no published price": the route names no
    // version, and the version it names could not be read. The second is not
    // reachable through an ordinary write — `price_version_id` is a foreign key
    // `ON DELETE RESTRICT` — but the two are the same fact for a ceiling, and
    // resolving them to the same value is what stops the unreachable arm from
    // becoming the permissive one if it ever is reached.
    const price =
      candidate.priceVersionId === null ? undefined : prices.get(candidate.priceVersionId);
    const violated = violatedConstraints(constraints, candidate, price);
    if (violated.length === 0) {
      kept.push(candidate);
      continue;
    }
    for (const constraint of violated) {
      if (!excludedBy.includes(constraint)) excludedBy.push(constraint);
    }
  }

  return { kept, excludedBy };
}

/* -------------------------------------------------------------------------- */
/*  4. The customer-safe projection                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every `inference_deployments` column the customer projection may read.
 *
 * An explicit ALLOW-LIST, which is what makes this default-deny: a column added
 * to that table tomorrow is not here, so the serializer's input type does not
 * carry it and no customer can be shown it by accident. A deny-list would have
 * the opposite default and would need somebody to remember.
 *
 * `id`, `modelRevisionId`, `priceVersionId`, `internalRouteId`, the legal-review
 * group and the wholesale-cost group are all deliberately absent — see
 * `INTERNAL_DEPLOYMENT_COLUMNS`, which names every one of them with a reason.
 * The two lists together must cover the table exactly; the schema test fails
 * naming any column in neither.
 */
export const CUSTOMER_SAFE_DEPLOYMENT_COLUMNS = {
  providerSlug: inferenceDeployments.providerSlug,
  regions: inferenceDeployments.regions,
  retainsPayloads: inferenceDeployments.retainsPayloads,
  retentionDays: inferenceDeployments.retentionDays,
  trainsOnCustomerData: inferenceDeployments.trainsOnCustomerData,
  zeroDataRetentionAvailable: inferenceDeployments.zeroDataRetentionAvailable,
  subprocessors: inferenceDeployments.subprocessors,
  policyUrl: inferenceDeployments.policyUrl,
  availabilityScope: inferenceDeployments.availabilityScope,
  commercialPermission: inferenceDeployments.commercialPermission,
} as const;

/**
 * The columns a customer must never see, each with the reason — the other half
 * of the classification, kept beside the allow-list so the pair can be read as
 * one decision.
 *
 * TypeScript PROPERTY names, matching `protectedColumns.ts`: a drizzle
 * selection object is keyed by property, not by SQL name.
 *
 * A superset of the protected-column registry, and deliberately so. Protection
 * is about a value that would be dangerous in a response; this list also holds
 * values that are merely INTERNAL (a row id, a timestamp) — harmless to leak,
 * but not part of the published contract, and therefore not something a
 * customer should start depending on.
 */
export const INTERNAL_DEPLOYMENT_COLUMNS: Readonly<Record<string, string>> = {
  id: 'The route’s own row id. `deploymentIdSchema` calls it opaque to customers: which concrete endpoint served a request is operational detail, and only the customer-safe subset of it is ever attributed back.',
  modelRevisionId:
    'An internal row id. The customer sees the revision LABEL (`2026-05-01`), which is the thing they pin; the id would be a second, private name for it.',
  permissionState:
    'The approval workflow’s own state. A customer sees a route or does not; showing them that one is `suspended` discloses a commercial or incident decision.',
  permissionStateChangedAt: 'When that decision was last taken. Same disclosure, with a date on it.',
  permissionStateChangedByUserId: 'Which staff member took it. Never customer-facing.',
  permissionStateNote: 'Why they took it, in prose written for staff.',
  legalReviewStatus:
    'Whether a contract review has happened. Discloses the existence and progress of a commercial negotiation.',
  legalReviewEvidenceRef: 'PROTECTED. A pointer into the contract register.',
  legalReviewedAt: 'When the review concluded. Dates a negotiation.',
  legalReviewedByUserId: 'Who concluded it. Never customer-facing.',
  status:
    'The catalogue’s own offerability decision. A route that is not offerable is simply absent from the customer’s catalogue, which is the honest form of the answer; publishing the state would invite it to be read as a health signal, which it is not.',
  dedicatedCapacity:
    'Whether capacity is reserved for one enterprise account. Discloses another customer’s commercial arrangement.',
  priceVersionId:
    'The ledger’s identifier for the price. The customer sees the price SNAPSHOT (`pricing`), copied onto the entry; the version id is the ledger’s internal handle.',
  platformFeePriceVersionId:
    'The ledger’s identifier for a BYOK platform fee. It is operational billing configuration, not a public catalogue field.',
  internalRouteId: 'PROTECTED. The data plane’s own route identifier.',
  upstreamWholesaleCostAmount: 'PROTECTED. What Oxy pays upstream.',
  upstreamWholesaleCostCurrency: 'PROTECTED. Half of the wholesale rate.',
  upstreamWholesaleCostUnit: 'PROTECTED. The unit the wholesale rate is quoted per.',
  upstreamWholesaleCostPer: 'PROTECTED. The denominator of the wholesale rate.',
  createdAt: 'When the row was written. Internal bookkeeping, not a published fact about the model.',
  updatedAt: 'The same.',
};

/**
 * The deployment shape the customer serializer is allowed to see.
 *
 * This type is the structural guarantee: `internalRouteId` and
 * `upstreamWholesaleCostAmount` are not properties of it, so a serializer that
 * reaches for one fails to compile. It is derived from the allow-list rather
 * than written out, so the two can never disagree.
 */
export type CustomerSafeDeploymentRow = SelectedRow<typeof CUSTOMER_SAFE_DEPLOYMENT_COLUMNS>;

/**
 * A deployment row as the catalogue READS it: the customer-safe projection plus
 * the price-version JOIN KEY.
 *
 * `priceVersionId` stays in {@link INTERNAL_DEPLOYMENT_COLUMNS} and out of the
 * allow-list — the two lists must not name the same column, and the schema test
 * fails if they do. It rides along under a `join` name for the same reason
 * `joinModelId` and `joinRevisionId` do: it is a key the serializer resolves
 * something else THROUGH, never a field it copies out. What the customer is
 * shown is the price SNAPSHOT the key resolves to, which
 * `priceSnapshotSchema` publishes with the version id inside it.
 */
type CatalogueDeploymentRow = CustomerSafeDeploymentRow & {
  readonly joinPriceVersionId: string | null;
};

/* -------------------------------------------------------------------------- */
/*  Canonical reference composition                                           */
/* -------------------------------------------------------------------------- */

/**
 * `<publisher>/<model>@<revision>` — composed in exactly one place.
 *
 * The model id half is composed by the DATABASE (a generated column on
 * `inference_models`), because both its parts live in one row. A revision
 * reference cannot be: its parts live in two tables and a generated column sees
 * only its own row. So this function is the single site, and every caller goes
 * through it rather than concatenating locally.
 */
export function composeModelReference(modelId: string, revision: string): string {
  return `${modelId}@${revision}`;
}

/* -------------------------------------------------------------------------- */
/*  Reading the catalogue                                                     */
/* -------------------------------------------------------------------------- */

/** A model row joined to its publisher, as the catalogue reads it. */
interface CatalogueModelRow {
  readonly id: string;
  readonly modelId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly publisherSlug: string;
  readonly publisherDisplayName: string;
  readonly publisherWebsiteUrl: string | null;
  readonly inputModalities: string[];
  readonly outputModalities: string[];
  readonly supportsTools: boolean;
  readonly supportsParallelToolCalls: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsJsonMode: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsPromptCaching: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly licenseId: string;
  readonly licenseDisplayName: string;
  readonly licenseUrl: string | null;
  readonly commercialUseAllowed: boolean;
  readonly requiresAttribution: boolean;
  readonly acceptableUsePolicyUrl: string | null;
  readonly releaseKind: string;
  readonly baseModelReference: string | null;
  readonly trainingOrganization: string | null;
  readonly knowledgeCutoff: string | null;
  readonly releasedOn: string | null;
  readonly deprecationStatus: string;
  readonly replacementModelReference: string | null;
  readonly deprecationAnnouncedAt: Date | null;
  readonly deprecationSunsetAt: Date | null;
}

/** A revision row as the catalogue reads it. */
interface CatalogueRevisionRow {
  readonly id: string;
  readonly modelId: string;
  readonly revision: string;
  readonly isCurrent: boolean;
  readonly releasedAt: Date;
  readonly retiredAt: Date | null;
  readonly modelCardUrl: string | null;
  readonly contentFilteringDefault: string | null;
  readonly provenanceMarking: string | null;
  readonly safetyCardUrl: string | null;
  readonly knownLimitations: string[] | null;
}

/** A provider row, reduced to what a customer may be told about it. */
interface CatalogueProviderRow {
  readonly slug: string;
  readonly displayName: string;
}

/** Conservative policy guaranteed across every route in a catalogue group. */
function aggregateDataPolicy(deployments: readonly CustomerSafeDeploymentRow[]) {
  const policyUrls = new Set(deployments.map((deployment) => deployment.policyUrl));
  const onlyPolicyUrl = policyUrls.size === 1 ? [...policyUrls][0] : null;
  return {
    retainsPayloads: deployments.some((deployment) => deployment.retainsPayloads),
    retentionDays: Math.max(...deployments.map((deployment) => deployment.retentionDays)),
    trainsOnCustomerData: deployments.some((deployment) => deployment.trainsOnCustomerData),
    zeroDataRetentionAvailable: deployments.every(
      (deployment) => deployment.zeroDataRetentionAvailable
    ),
    subprocessors: [...new Set(deployments.flatMap((deployment) => deployment.subprocessors ?? []))]
      .sort(),
    ...(onlyPolicyUrl === null ? {} : { policyUrl: onlyPolicyUrl }),
  };
}

/**
 * The published price for every price version named by a set of routes, as the
 * CUSTOMER-FACING snapshot, keyed by version id.
 *
 * Reads through {@link loadCandidatePrices} rather than querying the price tables
 * a second time, so the price a customer is quoted and the price their routing
 * ceilings are compared against come from ONE read of ONE pair of tables. One
 * query for the whole listing, never one per entry: `GET /models` is uncached per
 * request, so a per-entry lookup would make the catalogue's cost grow with the
 * number of models it serves.
 *
 * A version with no unit-price rows resolves to NOTHING here, which is the one
 * place this projection deliberately differs from the constraint filter's.
 * `priceSnapshotSchema` requires at least one unit price, so an empty snapshot
 * cannot be published at all — and the honest reading of a priced route whose
 * prices are missing is "we cannot quote this", which is what an absent `pricing`
 * says. The alternative, a snapshot with an empty `unitPrices`, would fail the
 * parse and take the whole listing down for every customer. A ceiling needs the
 * opposite treatment of the same row, and gets it: see {@link CandidatePrice}.
 */
async function loadPriceSnapshots(
  priceVersionIds: readonly string[]
): Promise<ReadonlyMap<string, PriceSnapshot>> {
  const prices = await loadCandidatePrices(priceVersionIds);

  const snapshots = new Map<string, PriceSnapshot>();
  for (const [priceVersionId, price] of prices) {
    if (price.unitPrices.length === 0) continue;
    // Parsed rather than cast. `exactDecimalSchema` is BRANDED precisely so an
    // unchecked `string` off a database row cannot become an amount, and its own
    // docs name `.parse()` as how a producer constructs one. It cannot fail on
    // well-formed data — the column is `numeric(_, INFERENCE_MONEY_SCALE)` with a
    // `>= 0` check, which is exactly what the brand's regex admits — so a failure
    // here means the ledger's own schema disagrees with the money contract, which
    // is worth hearing about loudly rather than serving a price around.
    snapshots.set(
      priceVersionId,
      priceSnapshotSchema.parse({
        priceVersionId,
        currency: price.currency,
        // The same construction as the settled receipt's
        // (`inferenceEdge.service.ts`' `readGenerationReceipt`): each unit price
        // carries the PARENT version's currency, which the table's own check
        // constrains it to. Copied rather than re-derived so a customer's quote and
        // the receipt that later prices them cannot disagree in shape.
        unitPrices: price.unitPrices.map((unitPrice) => ({
          unit: unitPrice.unit,
          amount: unitPrice.amount,
          per: unitPrice.per,
          currency: price.currency,
        })),
      })
    );
  }

  return snapshots;
}

/**
 * Build one customer-facing catalogue entry.
 *
 * Every parameter is already narrowed to a customer-safe shape, so this
 * function has no opportunity to leak: `deployments` is
 * `CatalogueDeploymentRow[]`, whose type has no internal route id and no
 * wholesale cost to read. The `.parse()` at the end is the second, runtime
 * guard — it strips anything unknown and fails loudly on anything malformed.
 *
 * No route is selected here. Runtime selection belongs to the edge and uses
 * profile priority, reviewed score and exact deployment id. The catalogue emits
 * one price/scope/permission only when every visible route agrees; otherwise it
 * omits the singular field instead of inventing a representative by name or DB
 * order. Its data policy is the conservative guarantee across all visible routes.
 *
 * Absent `pricing` on a LISTED entry means the visible routes do not share one
 * complete price snapshot: they may disagree on the price version, or the only
 * version may be absent/incomplete. The edge does not infer from this projection;
 * it validates the exact selected deployment's price independently and fails
 * closed when that evidence is missing or mismatched. A `byok_only` route keeps
 * its upstream provider `price_version_id` NULL and is NOT reachable through
 * this customer catalogue: `byok_only` remains in {@link UNGRANTABLE_SCOPES}.
 * Its separately reviewed platform-fee version is internal edge configuration,
 * never a reason to publish the BYOK row or its identifier here.
 */
function buildCatalogueEntry(
  model: CatalogueModelRow,
  currentRevision: CatalogueRevisionRow,
  availableRevisions: readonly CatalogueRevisionRow[],
  deployments: readonly CatalogueDeploymentRow[],
  providersBySlug: ReadonlyMap<string, CatalogueProviderRow>,
  evaluations: readonly { suite: string; metric: string; score: string; evaluatedAt: Date | null; reportUrl: string | null }[],
  priceSnapshotsByVersionId: ReadonlyMap<string, PriceSnapshot>
): ModelCatalogueEntry | null {
  if (model.modelId === null || deployments.length === 0) return null;

  const priceVersionIds = new Set(deployments.map((deployment) => deployment.joinPriceVersionId));
  const onlyPriceVersionId = priceVersionIds.size === 1 ? [...priceVersionIds][0] : null;
  const pricing =
    onlyPriceVersionId === null
      ? undefined
      : priceSnapshotsByVersionId.get(onlyPriceVersionId);
  const availabilityScopes = new Set(deployments.map((deployment) => deployment.availabilityScope));
  const commercialPermissions = new Set(
    deployments.map((deployment) => deployment.commercialPermission)
  );

  const regions = [...new Set(deployments.flatMap((deployment) => deployment.regions))].sort();

  const servingProviders = [...new Set(deployments.map((deployment) => deployment.providerSlug))]
    .sort()
    .flatMap((slug) => {
      const provider = providersBySlug.get(slug);
      const providerDeployments = deployments.filter((candidate) => candidate.providerSlug === slug);
      if (provider === undefined || providerDeployments.length === 0) return [];
      return [
        {
          slug: provider.slug,
          displayName: provider.displayName,
          regions: [...new Set(providerDeployments.flatMap((deployment) => deployment.regions))]
            .sort(),
          dataPolicy: aggregateDataPolicy(providerDeployments),
        },
      ];
    });

  const entry = {
    schemaVersion: 2 as const,
    modelId: model.modelId,
    publisher: {
      slug: model.publisherSlug,
      displayName: model.publisherDisplayName,
      ...(model.publisherWebsiteUrl === null ? {} : { websiteUrl: model.publisherWebsiteUrl }),
    },
    displayName: model.displayName,
    ...(model.description === null ? {} : { description: model.description }),
    currentRevision: currentRevision.revision,
    availableRevisions: availableRevisions.map((revision) => revision.revision),
    capabilities: {
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      tools: model.supportsTools,
      parallelToolCalls: model.supportsParallelToolCalls,
      structuredOutput: model.supportsStructuredOutput,
      jsonMode: model.supportsJsonMode,
      reasoning: model.supportsReasoning,
      streaming: model.supportsStreaming,
      promptCaching: model.supportsPromptCaching,
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
    },
    license: {
      licenseId: model.licenseId,
      displayName: model.licenseDisplayName,
      ...(model.licenseUrl === null ? {} : { url: model.licenseUrl }),
      commercialUseAllowed: model.commercialUseAllowed,
      requiresAttribution: model.requiresAttribution,
      ...(model.acceptableUsePolicyUrl === null
        ? {}
        : { acceptableUsePolicyUrl: model.acceptableUsePolicyUrl }),
    },
    provenance: {
      releaseKind: model.releaseKind,
      ...(model.baseModelReference === null ? {} : { baseModelId: model.baseModelReference }),
      ...(model.trainingOrganization === null
        ? {}
        : { trainingOrganization: model.trainingOrganization }),
    },
    ...(model.knowledgeCutoff === null ? {} : { knowledgeCutoff: model.knowledgeCutoff }),
    ...(model.releasedOn === null ? {} : { releasedOn: model.releasedOn }),
    regions,
    servingProviders,
    dataPolicy: aggregateDataPolicy(deployments),
    ...(pricing === undefined ? {} : { pricing }),
    ...(availabilityScopes.size === 1
      ? { availabilityScope: [...availabilityScopes][0] }
      : {}),
    ...(commercialPermissions.size === 1
      ? { commercialPermission: [...commercialPermissions][0] }
      : {}),
    deprecation: {
      status: model.deprecationStatus,
      ...(model.replacementModelReference === null
        ? {}
        : { replacementModelReference: model.replacementModelReference }),
      ...(model.deprecationAnnouncedAt === null
        ? {}
        : { announcedAt: model.deprecationAnnouncedAt.toISOString() }),
      ...(model.deprecationSunsetAt === null
        ? {}
        : { sunsetAt: model.deprecationSunsetAt.toISOString() }),
    },
    evaluations: evaluations.map((evaluation) => ({
      suite: evaluation.suite,
      metric: evaluation.metric,
      score: evaluation.score,
      ...(evaluation.evaluatedAt === null
        ? {}
        : { evaluatedAt: evaluation.evaluatedAt.toISOString() }),
      ...(evaluation.reportUrl === null ? {} : { reportUrl: evaluation.reportUrl }),
    })),
    ...(currentRevision.contentFilteringDefault === null || currentRevision.provenanceMarking === null
      ? {}
      : {
          safety: {
            ...(currentRevision.safetyCardUrl === null
              ? {}
              : { safetyCardUrl: currentRevision.safetyCardUrl }),
            contentFilteringDefault: currentRevision.contentFilteringDefault,
            knownLimitations: currentRevision.knownLimitations ?? [],
            provenanceMarking: currentRevision.provenanceMarking,
          },
        }),
    ...(currentRevision.modelCardUrl === null ? {} : { modelCardUrl: currentRevision.modelCardUrl }),
  };

  return modelCatalogueEntrySchema.parse(entry);
}

/**
 * The customer-facing catalogue for one viewer.
 *
 * A model appears only when it has an offerable route the viewer may see AND a
 * current revision that is not retired. Both absences resolve to "not in the
 * catalogue", which is the default-deny reading — a model whose revisions have
 * all been retired is not something a customer can call.
 */
export async function listCatalogueForViewer(
  viewer: CatalogueViewer
): Promise<ModelCatalogueEntry[]> {
  // A viewer with no scopes can see nothing. Stated as an early return rather
  // than left to `inArray(col, [])`, which drizzle renders as a literal `false`
  // and would give the same answer — but by an accident of the query builder
  // rather than by a decision anybody wrote down.
  if (viewer.scopes.length === 0) return [];

  const db = getDb();

  const deploymentRows = await db
    .select({
      ...CUSTOMER_SAFE_DEPLOYMENT_COLUMNS,
      // Join keys, not part of the customer shape — see the serializer, whose
      // parameter type is `CatalogueDeploymentRow` and therefore cannot read the
      // internal route id or the wholesale cost even though this query could
      // have asked for them.
      joinModelId: inferenceModelRevisions.modelId,
      joinRevisionId: inferenceModelRevisions.id,
      joinPriceVersionId: inferenceDeployments.priceVersionId,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .where(selectableDeploymentWhere(viewer));

  if (deploymentRows.length === 0) return [];

  const modelIds = [...new Set(deploymentRows.map((row) => row.joinModelId))];

  const modelRows = await db
    .select({
      id: inferenceModels.id,
      modelId: inferenceModels.modelId,
      displayName: inferenceModels.displayName,
      description: inferenceModels.description,
      publisherSlug: inferenceModels.publisherSlug,
      publisherDisplayName: inferencePublishers.displayName,
      publisherWebsiteUrl: inferencePublishers.websiteUrl,
      inputModalities: inferenceModels.inputModalities,
      outputModalities: inferenceModels.outputModalities,
      supportsTools: inferenceModels.supportsTools,
      supportsParallelToolCalls: inferenceModels.supportsParallelToolCalls,
      supportsStructuredOutput: inferenceModels.supportsStructuredOutput,
      supportsJsonMode: inferenceModels.supportsJsonMode,
      supportsReasoning: inferenceModels.supportsReasoning,
      supportsStreaming: inferenceModels.supportsStreaming,
      supportsPromptCaching: inferenceModels.supportsPromptCaching,
      maxContextTokens: inferenceModels.maxContextTokens,
      maxOutputTokens: inferenceModels.maxOutputTokens,
      licenseId: inferenceModels.licenseId,
      licenseDisplayName: inferenceModels.licenseDisplayName,
      licenseUrl: inferenceModels.licenseUrl,
      commercialUseAllowed: inferenceModels.commercialUseAllowed,
      requiresAttribution: inferenceModels.requiresAttribution,
      acceptableUsePolicyUrl: inferenceModels.acceptableUsePolicyUrl,
      releaseKind: inferenceModels.releaseKind,
      baseModelReference: inferenceModels.baseModelReference,
      trainingOrganization: inferenceModels.trainingOrganization,
      knowledgeCutoff: inferenceModels.knowledgeCutoff,
      releasedOn: inferenceModels.releasedOn,
      deprecationStatus: inferenceModels.deprecationStatus,
      replacementModelReference: inferenceModels.replacementModelReference,
      deprecationAnnouncedAt: inferenceModels.deprecationAnnouncedAt,
      deprecationSunsetAt: inferenceModels.deprecationSunsetAt,
    })
    .from(inferenceModels)
    .innerJoin(inferencePublishers, eq(inferenceModels.publisherSlug, inferencePublishers.slug))
    .where(inArray(inferenceModels.id, modelIds));

  const revisionRows = await db
    .select({
      id: inferenceModelRevisions.id,
      modelId: inferenceModelRevisions.modelId,
      revision: inferenceModelRevisions.revision,
      isCurrent: inferenceModelRevisions.isCurrent,
      releasedAt: inferenceModelRevisions.releasedAt,
      retiredAt: inferenceModelRevisions.retiredAt,
      modelCardUrl: inferenceModelRevisions.modelCardUrl,
      contentFilteringDefault: inferenceModelRevisions.contentFilteringDefault,
      provenanceMarking: inferenceModelRevisions.provenanceMarking,
      safetyCardUrl: inferenceModelRevisions.safetyCardUrl,
      knownLimitations: inferenceModelRevisions.knownLimitations,
    })
    .from(inferenceModelRevisions)
    .where(inArray(inferenceModelRevisions.modelId, modelIds))
    .orderBy(desc(inferenceModelRevisions.releasedAt));

  const providerRows = await db
    .select({ slug: inferenceProviders.slug, displayName: inferenceProviders.displayName })
    .from(inferenceProviders)
    .where(
      inArray(inferenceProviders.slug, [
        ...new Set(deploymentRows.map((row) => row.providerSlug)),
      ])
    );
  const providersBySlug = new Map(providerRows.map((row) => [row.slug, row]));

  const currentRevisionIds = revisionRows
    .filter((revision) => revision.isCurrent)
    .map((revision) => revision.id);
  const evaluationRows =
    currentRevisionIds.length === 0
      ? []
      : await db
          .select({
            modelRevisionId: inferenceModelEvaluations.modelRevisionId,
            suite: inferenceModelEvaluations.suite,
            metric: inferenceModelEvaluations.metric,
            score: inferenceModelEvaluations.score,
            evaluatedAt: inferenceModelEvaluations.evaluatedAt,
            reportUrl: inferenceModelEvaluations.reportUrl,
          })
          .from(inferenceModelEvaluations)
          .where(inArray(inferenceModelEvaluations.modelRevisionId, currentRevisionIds))
          .orderBy(asc(inferenceModelEvaluations.suite), asc(inferenceModelEvaluations.metric));

  // Every price version any listed route names, resolved in two queries before
  // the loop rather than inside it.
  const priceSnapshotsByVersionId = await loadPriceSnapshots([
    ...new Set(
      deploymentRows.flatMap((row) =>
        row.joinPriceVersionId === null ? [] : [row.joinPriceVersionId]
      )
    ),
  ]);

  const entries: ModelCatalogueEntry[] = [];
  for (const model of modelRows) {
    const revisions = revisionRows.filter((revision) => revision.modelId === model.id);
    const currentRevision = revisions.find((revision) => revision.isCurrent);
    if (currentRevision === undefined || currentRevision.retiredAt !== null) continue;

    const availableRevisions = revisions.filter((revision) => revision.retiredAt === null);
    if (availableRevisions.length === 0) continue;

    // Only routes serving a revision this customer may pin. A deployment of a
    // retired revision is not offered, whatever its permission state says.
    const availableRevisionIds = new Set(availableRevisions.map((revision) => revision.id));
    const deployments = deploymentRows.filter(
      (row) => row.joinModelId === model.id && availableRevisionIds.has(row.joinRevisionId)
    );

    const entry = buildCatalogueEntry(
      model,
      currentRevision,
      availableRevisions,
      deployments,
      providersBySlug,
      evaluationRows.filter((row) => row.modelRevisionId === currentRevision.id),
      priceSnapshotsByVersionId
    );
    if (entry !== null) entries.push(entry);
  }

  return entries.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

/**
 * One entry by canonical model id, for the same viewer rules.
 *
 * Reuses the list rather than issuing a narrower query on purpose: a second
 * query would be a second place the selectability predicate could drift, and
 * "the detail page shows a route the list does not" is exactly the failure that
 * would produce.
 */
export async function getCatalogueEntryForViewer(
  viewer: CatalogueViewer,
  modelId: string
): Promise<ModelCatalogueEntry | undefined> {
  const entries = await listCatalogueForViewer(viewer);
  return entries.find((entry) => entry.modelId === modelId);
}

/* -------------------------------------------------------------------------- */
/*  Selecting a concrete route                                                */
/* -------------------------------------------------------------------------- */

/** What a viewer is told when a route resolves — never the internal route id. */
export interface SelectedRoute {
  /** `<publisher>/<model>@<revision>` — always revision-pinned. */
  readonly modelReference: string;
  readonly provider: string;
  readonly regions: readonly string[];
  readonly availabilityScope: AvailabilityScope;
}

/**
 * Resolve a customer's model reference to a route they may actually be served,
 * under a given routing policy.
 *
 * Accepts both forms `modelReferenceSchema` admits: `<publisher>/<model>`
 * resolves to the model's current revision, `<publisher>/<model>@<revision>`
 * resolves to exactly those weights or to nothing. A pinned request is never
 * substituted — that is the ADR's rule, and it is why the pinned branch below
 * has no fallback to the current revision.
 *
 * `constraints` is REQUIRED, not optional. A request served under no configured
 * policy passes {@link UNCONSTRAINED_ROUTING} by name, so "this one is
 * unconstrained" is a decision in the caller's source rather than an argument
 * nobody supplied — which is precisely how the three data-handling controls came
 * to be stored, versioned and never read (issue #1011).
 *
 * Returns `undefined` when no route qualifies, INCLUDING when a policy excluded
 * every candidate. Callers must treat that as a refusal, never as "pick
 * something else": an internal-only route being invisible to a public
 * credential and a model not existing at all are deliberately the same answer,
 * so the catalogue is not an oracle for what Oxy runs internally. A caller who
 * must tell the customer WHICH control refused them uses
 * {@link resolveEdgeRoute}, whose `policy-excluded` arm names it — this one
 * answers a catalogue question, not a request.
 */
export async function selectRouteForViewer(
  viewer: CatalogueViewer,
  modelReference: string,
  constraints: RoutingConstraints
): Promise<SelectedRoute | undefined> {
  // Compatibility projection for internal callers/tests. There is deliberately
  // no second selector here: the authoritative resolver applies exact identity,
  // price and balanced-score evidence, including the deployment-ID tie-break.
  const resolution = await resolveEdgeRoute(
    viewer,
    modelReference,
    constraints,
    TEXT_COMPLETION_MODALITY,
    'balanced',
    UNCONSTRAINED_EDGE_CAPACITY,
    undefined
  );
  if (resolution.status !== 'resolved') return undefined;
  return {
    modelReference: resolution.route.modelReference,
    provider: resolution.route.provider,
    regions: resolution.route.regions,
    availabilityScope: resolution.route.availabilityScope,
  };
}

/* -------------------------------------------------------------------------- */
/*  The internal resolution the public edge admits against                    */
/* -------------------------------------------------------------------------- */

/**
 * A route as the EDGE needs it, which is not what a customer is shown.
 *
 * {@link SelectedRoute} answers "what may I tell the caller about where this
 * went". This answers "may I admit this request, and against what". Three fields
 * the customer never sees make that decision possible:
 *
 *  - `priceVersionId`, because a hold has to be sized in money and money comes
 *    from a price version. A route with no published price cannot be charged, so
 *    it cannot be admitted — see {@link EdgeRouteResolution}'s
 *    `routing-evidence-unavailable` arm.
 *  - `maxContextTokens` / `maxOutputTokens`, because a request that cannot fit is
 *    refused AT THE EDGE rather than forwarded and paid for. Inheriting whatever
 *    the upstream provider happens to enforce is how a customer is billed for a
 *    request that was never going to succeed.
 *
 * `deploymentId` and `regions` are also admission evidence: the exact deployment
 * id must map uniquely and every declared region must survive the customer's
 * controls before the route can enter the signed `authorizedRoutes` list (ADR
 * 0017, `authorizedRouteSchema`). Neither value is customer-facing — the id is
 * Kaana's opaque key and regions are policy evidence, not a display choice.
 *
 * It goes through {@link selectableDeploymentWhere} like every other read, so an
 * admission can never reach a route the catalogue would not offer.
 */
export interface EdgeRoute {
  /**
   * `inference_deployments.internal_route_id` — Kaana's exact endpoint identity.
   * Opaque to customers and never in a customer projection; it crosses only to
   * the data plane, which resolves it against its own inventory.
   */
  readonly deploymentId: string;
  /** Reviewed score for this request's explicit optimisation dimension. */
  readonly routingScore: number;
  /** `<publisher>/<model>@<revision>` — always revision-pinned. */
  readonly modelReference: string;
  readonly provider: string;
  /**
   * Every ATTESTED region this deployment MAY serve from, plural because
   * `modelDeploymentSchema.regions` is. Oxy checked a non-empty set against the
   * customer's residency controls as a SUBSET, so choosing among them cannot
   * escape the policy and the choice stays routing execution (ADR 0006). Empty
   * means no location was attested and survives only when the request carries no
   * explicit regional control; it never means global.
   */
  readonly regions: readonly string[];
  readonly availabilityScope: AvailabilityScope;
  /** The price version a hold is sized against and a receipt is settled at. */
  readonly priceVersionId: string;
  /** Exact Kaana generation; present only on an authenticated BYOK route. */
  readonly customerProviderCredential?: NonNullable<
    AuthorizedRoute['customerProviderCredential']
  >;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /**
  * What the model accepts and produces. Non-empty by CHECK on `inference_models`,
  * which also constrains the values to `INFERENCE_MODALITIES`.
  *
  * Typed `string[]` and NOT the modality union, deliberately. These arrive from
  * the database as `text[]`, so a union type here would be a claim about stored
  * data that nothing in this process verifies — the same shape of mistake as a
  * required field on a wire type that the wire may omit. Every use is a
  * membership test or an error message, neither of which needs the narrower type.
  */
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
}

/**
 * What a request needs a route to be able to do, checked before the route is
 * admitted rather than discovered by the data plane.
 *
 * ## Why this is a parameter and not a routing constraint
 *
 * {@link RoutingConstraints} is `Pick<RoutingPolicy, …>` — every member is a
 * field the CUSTOMER set, and `policy-excluded` tells them which of their own
 * controls refused. A modality is not theirs: it is a property of the endpoint
 * they called. Folding it in would answer "your policy excluded every route" to a
 * customer whose policy is empty, and send them to change a setting that was
 * never involved.
 *
 * ## Why `output` is optional
 *
 * `INFERENCE_MODALITIES` is `text | image | audio | video | embedding`, and that
 * vocabulary **cannot express a ranking**. `POST /v1/rerank` consumes text and
 * returns indices with relevance scores, which is none of the five. So rerank
 * constrains its INPUT and leaves its output unconstrained, rather than claiming
 * a modality that would be false. A `ranking` member would be a `@oxyhq/contracts`
 * enum change, and therefore a two-repo release (Kaana derives its own contract
 * from the published package and gates on drift) — not something to smuggle in
 * behind an endpoint.
 *
 * Absent `output` is therefore a deliberate, documented weakening for exactly one
 * endpoint. It is not a default: every caller states it, and the compiler makes
 * them.
 */
export interface EdgeModalityRequirement {
  readonly input: InferenceModalityValue;
  readonly output?: InferenceModalityValue;
}

/** Request-specific capacity a route must have before it can enter an envelope. */
export interface EdgeCapacityRequirement {
  readonly inputTokens: number;
  /** A completion without an explicit limit reserves the model's full output ceiling. */
  readonly outputTokens: number | 'model-maximum';
}

/** Capacity-neutral value for catalogue unit tests that exercise other constraints. */
export const UNCONSTRAINED_EDGE_CAPACITY: EdgeCapacityRequirement = {
  inputTokens: 0,
  outputTokens: 0,
};

/** The requirement a text-in, text-out completion places on a route. */
export const TEXT_COMPLETION_MODALITY: EdgeModalityRequirement = {
  input: 'text',
  output: 'text',
};

/**
 * Exact authenticated request identity required before a BYOK-only catalogue
 * row may even be considered. Public catalogue reads pass `undefined` and can
 * never widen themselves into the BYOK audience.
 */
export interface AuthenticatedEdgeRoutingContext {
  readonly applicationId: string;
  readonly environment: InferenceEnvironment;
}

/**
 * Outcome of {@link resolveEdgeRoute}.
 *
 * `unknown-model` is distinct from `routing-evidence-unavailable`: a model that
 * does not exist (or that this viewer may not see) is a request error, while a
 * surviving route with incomplete identity, price or score evidence is an Oxy
 * configuration gap. The edge maps the latter to one generic 503 without
 * leaking which internal datum is incomplete.
 *
 * `policy-excluded` is a third fact and the customer's own: routes for this
 * model exist and this credential may see them, and the customer's OWN policy
 * forbids every one of them. It names the controls that did it, because "no
 * route is available" without them is advice to raise a support ticket about a
 * setting the customer can change themselves. It is reachable ONLY when at least
 * one candidate survived the selectability predicate — an empty candidate set
 * stays `unknown-model`, so a policy refusal can never be produced by a model
 * that was never there (issue #1011).
 */
export type EdgeRouteResolution =
  | {
      readonly status: 'resolved';
      readonly route: EdgeRoute;
      /**
       * The OTHER routes that survived the same policy, in the same preference
       * order — the same-model failover destinations, and the set ADR 0017's
       * `authorizedRoutes` is built from.
       *
       * Every entry serves the SAME model line and the same revision as `route`,
       * by construction: candidates are gathered for one `model_id` and then
       * narrowed to one revision (the pinned one, or the single current one that
       * `inference_model_revisions_one_current_per_model` permits). So the
       * envelope's `substitution` for each is `same_model`, never a cross-model
       * substitute.
       *
       * Every survivor has already passed the same complete-envelope evidence
       * check. No alternate is silently dropped for a missing exact id, price or
       * score: one incomplete survivor refuses the whole request before a hold is
       * reserved or Kaana is called.
       *
       * Whether the customer's policy actually AUTHORIZES failover among these is
       * not decided here. `fallback` is not a {@link RoutingConstraint} — it
       * governs a switch between routes rather than the qualification of one — so
       * this returns the set and the edge applies `fallback` to it. See
       * {@link UNFILTERED_ROUTING_CONTROLS}.
       */
      readonly alternates: readonly EdgeRoute[];
    }
  | { readonly status: 'unknown-model'; readonly modelReference: string }
  | {
      readonly status: 'routing-evidence-unavailable';
      readonly modelReference: string;
      readonly reason:
        | 'missing-exact-deployment-id'
        | 'deployment-id-collision'
        | 'missing-price'
        | 'price-identity-mismatch'
        | 'price-inactive'
        | 'price-not-effective'
        | 'missing-score'
        | 'stale-score'
        | 'score-price-mismatch'
        | 'unsupported-optimisation';
    }
  | {
      readonly status: 'policy-excluded';
      readonly modelReference: string;
      /** Non-empty by construction. Deterministically ordered. */
      readonly constraints: readonly RoutingConstraint[];
    }
  | {
      readonly status: 'modality-unsupported';
      readonly modelReference: string;
      readonly required: EdgeModalityRequirement;
      /** What the candidate routes actually declare, deduplicated and sorted. */
      readonly supportedInput: readonly string[];
      readonly supportedOutput: readonly string[];
    }
  | {
      readonly status: 'capacity-unavailable';
      readonly modelReference: string;
      readonly outputLimitExceeded: boolean;
      readonly contextLimitExceeded: boolean;
    }
  | {
      readonly status: 'customer-provider-credential-unavailable';
      readonly modelReference: string;
    };

/**
 * Resolve a customer's model reference to the route the edge may admit against,
 * under the routing policy in force for that request.
 *
 * Same rules as {@link selectRouteForViewer} — both reference forms, no
 * substitution of a pinned revision, no fallback when nothing qualifies, the
 * same single selectability predicate and the same REQUIRED constraints. What
 * differs is only that this one also reports the price version and the model's
 * ceilings, and that it names the controls behind a policy refusal.
 *
 * The order of the last three steps is load-bearing. Candidates are narrowed by
 * the policy BEFORE a price version is read, so a route the policy forbids is
 * never reported as an Oxy pricing gap; and the policy is applied to the whole
 * candidate set rather than to `candidates[0]`, so a conforming route ranked
 * second is served rather than refused.
 *
 * That ordering also decides which answer an UNPRICED route gets. With no price
 * ceiling in force it reaches complete-envelope validation and fails closed as
 * unavailable routing evidence. With one, the ceiling excludes it first — a
 * promise about what a request will cost cannot be kept by a route that publishes
 * no price — so the customer hears `policy-excluded` naming their own control,
 * which is the one of the two they can act on. See
 * {@link violatedConstraints}.
 *
 * ## `constraints` is required, and the shape that made it required
 *
 * Issue #1011 was not a wrong filter. It was that this function took two
 * arguments, and the ONE caller — `inferenceEdge.service.ts`'s
 * `executeInferenceRequest` — had already resolved the customer's policy five
 * lines above the call and passed it to neither. **The value was AVAILABLE and
 * NOT PASSED**, so nothing failed, nothing warned, and three compliance controls
 * were stored, versioned and recorded on receipts while being enforced nowhere.
 * That shape — a value in scope beside the thing it is supposed to constrain,
 * joined by nobody — is the one to recognise; it is the same shape as the other
 * findings this epic turned up, and it is invisible to every test that does not
 * already know to look for it.
 *
 * Hence a REQUIRED parameter, and never a default. A caller with no policy
 * passes {@link UNCONSTRAINED_ROUTING} by name, which is a sentence somebody
 * wrote; a default parameter would make omission compile again and put the same
 * bug straight back. Any resolver added to this file must take constraints the
 * same way, for the same reason.
 */
export async function resolveEdgeRoute(
  viewer: CatalogueViewer,
  modelReference: string,
  constraints: RoutingConstraints,
  modality: EdgeModalityRequirement,
  optimiseFor: RoutingPolicy['optimiseFor'] | RoutingProfile['optimiseFor'],
  capacity: EdgeCapacityRequirement,
  requestContext: AuthenticatedEdgeRoutingContext | undefined
): Promise<EdgeRouteResolution> {
  if (viewer.scopes.length === 0) {
    return { status: 'unknown-model', modelReference };
  }

  const separator = modelReference.indexOf('@');
  const modelId = separator === -1 ? modelReference : modelReference.slice(0, separator);
  const pinnedRevision = separator === -1 ? undefined : modelReference.slice(separator + 1);

  const db = getDb();
  const deploymentViewer: CatalogueViewer =
    requestContext === undefined
      ? viewer
      : {
          ...viewer,
          scopes: [...new Set([...viewer.scopes, 'byok_only' as const])],
        };
  const rows = await db
    .select({
      ...CONSTRAINT_COLUMNS,
      internalRouteId: inferenceDeployments.internalRouteId,
      scoreDeploymentId: inferenceDeploymentRoutingScores.deploymentId,
      scorePriceVersionId: inferenceDeploymentRoutingScores.priceVersionId,
      joinedPriceVersionId: priceVersions.id,
      joinedPriceStatus: priceVersions.status,
      joinedPriceModelReference: priceVersions.modelReference,
      joinedPriceProvider: priceVersions.provider,
      joinedPriceEffectiveFrom: priceVersions.effectiveFrom,
      joinedPriceEffectiveUntil: priceVersions.effectiveUntil,
      priceScore: inferenceDeploymentRoutingScores.priceScore,
      latencyScore: inferenceDeploymentRoutingScores.latencyScore,
      latencyMeasurementWindowEnd:
        inferenceDeploymentRoutingScores.latencyMeasurementWindowEnd,
      latencyValidUntil: inferenceDeploymentRoutingScores.latencyValidUntil,
      throughputScore: inferenceDeploymentRoutingScores.throughputScore,
      throughputMeasurementWindowEnd:
        inferenceDeploymentRoutingScores.throughputMeasurementWindowEnd,
      throughputValidUntil: inferenceDeploymentRoutingScores.throughputValidUntil,
      balancedScore: inferenceDeploymentRoutingScores.balancedScore,
      balancedValidUntil: inferenceDeploymentRoutingScores.balancedValidUntil,
      revision: inferenceModelRevisions.revision,
      isCurrent: inferenceModelRevisions.isCurrent,
      retiredAt: inferenceModelRevisions.retiredAt,
      resolvedModelId: inferenceModels.modelId,
      maxContextTokens: inferenceModels.maxContextTokens,
      maxOutputTokens: inferenceModels.maxOutputTokens,
      inputModalities: inferenceModels.inputModalities,
      outputModalities: inferenceModels.outputModalities,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .leftJoin(
      inferenceDeploymentRoutingScores,
      eq(inferenceDeployments.internalRouteId, inferenceDeploymentRoutingScores.deploymentId)
    )
    .leftJoin(priceVersions, eq(CONSTRAINT_COLUMNS.priceVersionId, priceVersions.id))
    .where(and(selectableDeploymentWhere(deploymentViewer), eq(inferenceModels.modelId, modelId)));

  const candidates = rows.filter((row) => {
    if (row.retiredAt !== null) return false;
    return pinnedRevision === undefined ? row.isCurrent : row.revision === pinnedRevision;
  });

  if (candidates.length === 0) {
    return { status: 'unknown-model', modelReference };
  }

  // A model that cannot do what the endpoint asks is refused HERE, before the
  // customer's own policy is consulted, because the two are different facts and
  // only one of them is theirs to fix. Ordering it after `applyRoutingConstraints`
  // would answer `policy_violation` to a caller whose policy is empty.
  //
  // This is also what makes every ceiling downstream a fact rather than an
  // assumption: an embeddings ceiling is only sound about a route that actually
  // produces embeddings, and before this filter existed an embeddings request
  // could resolve a chat-only model's route and be held against its price.
  const capable = candidates.filter(
    (row) =>
      row.inputModalities.includes(modality.input) &&
      (modality.output === undefined || row.outputModalities.includes(modality.output))
  );
  if (capable.length === 0) {
    return {
      status: 'modality-unsupported',
      modelReference,
      required: modality,
      supportedInput: sortedModalities(candidates.flatMap((row) => row.inputModalities)),
      supportedOutput: sortedModalities(candidates.flatMap((row) => row.outputModalities)),
    };
  }

  const permitted = await applyRoutingConstraints(constraints, capable);
  if (permitted.kept.length === 0) {
    // Refuse, and say what refused. Never widen back to a candidate the policy
    // excluded, and never answer as though the request had been unconstrained —
    // a request that cannot be served under its own policy is a refusal, not a
    // downgrade.
    return { status: 'policy-excluded', modelReference, constraints: permitted.excludedBy };
  }

  type ConnectedCandidate = (typeof permitted.kept)[number] & {
    readonly customerProviderCredential?: NonNullable<
      AuthorizedRoute['customerProviderCredential']
    >;
  };
  const connected: ConnectedCandidate[] = [];
  const connectionByProvider = new Map<
    string,
    ReturnType<typeof resolveProviderConnectionForApplication>
  >();
  for (const candidate of permitted.kept) {
    if (candidate.availabilityScope !== 'byok_only') {
      connected.push(candidate);
      continue;
    }
    if (requestContext === undefined) continue;
    let resolution = connectionByProvider.get(candidate.providerSlug);
    if (resolution === undefined) {
      resolution = resolveProviderConnectionForApplication({
        applicationId: requestContext.applicationId,
        provider: candidate.providerSlug,
        environment: requestContext.environment,
      });
      connectionByProvider.set(candidate.providerSlug, resolution);
    }
    const providerConnection = await resolution;
    if (providerConnection.status !== 'resolved') continue;
    const { connection } = providerConnection;
    if (
      connection.credentialHandle === undefined ||
      connection.credentialRevision === undefined
    ) {
      continue;
    }
    connected.push({
      ...candidate,
      customerProviderCredential: {
        credentialHandle: connection.credentialHandle,
        credentialRevision: connection.credentialRevision,
        ownerAccountId: connection.ownerAccountId,
        connectionId: connection.connectionId,
        environment: connection.environment,
      },
    });
  }
  if (connected.length === 0) {
    return { status: 'customer-provider-credential-unavailable', modelReference };
  }

  // Capacity is an ordinary availability fact, so it narrows the set BEFORE
  // exact identity, price and score evidence are validated. A too-small
  // cross-model fallback is never authorized for this request and therefore
  // cannot poison the otherwise complete envelope with irrelevant evidence.
  const capacityCompatible = connected.filter((candidate) => {
    const outputTokens =
      capacity.outputTokens === 'model-maximum'
        ? candidate.maxOutputTokens
        : capacity.outputTokens;
    return (
      candidate.maxOutputTokens >= outputTokens &&
      candidate.maxContextTokens >= capacity.inputTokens + outputTokens
    );
  });
  if (capacityCompatible.length === 0) {
    const explicitOutput =
      capacity.outputTokens === 'model-maximum' ? undefined : capacity.outputTokens;
    return {
      status: 'capacity-unavailable',
      modelReference,
      outputLimitExceeded:
        explicitOutput !== undefined &&
        connected.every((candidate) => candidate.maxOutputTokens < explicitOutput),
      contextLimitExceeded: connected.every((candidate) => {
        const outputTokens =
          capacity.outputTokens === 'model-maximum'
            ? candidate.maxOutputTokens
            : capacity.outputTokens;
        return candidate.maxContextTokens < capacity.inputTokens + outputTokens;
      }),
    };
  }

  const exactDeploymentIds: string[] = [];
  for (const candidate of capacityCompatible) {
    if (candidate.internalRouteId === null) {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: 'missing-exact-deployment-id',
      };
    }
    exactDeploymentIds.push(candidate.internalRouteId);
  }

  const approvedMappings = await db
    .select({ deploymentId: inferenceDeployments.internalRouteId })
    .from(inferenceDeployments)
    .where(
      and(
        eq(inferenceDeployments.permissionState, SELECTABLE_PERMISSION_STATE),
        inArray(inferenceDeployments.internalRouteId, exactDeploymentIds)
      )
    );
  const mappingCounts = new Map<string, number>();
  for (const mapping of approvedMappings) {
    if (mapping.deploymentId === null) continue;
    mappingCounts.set(mapping.deploymentId, (mappingCounts.get(mapping.deploymentId) ?? 0) + 1);
  }
  if (
    new Set(exactDeploymentIds).size !== exactDeploymentIds.length ||
    exactDeploymentIds.some((deploymentId) => mappingCounts.get(deploymentId) !== 1)
  ) {
    return {
      status: 'routing-evidence-unavailable',
      modelReference,
      reason: 'deployment-id-collision',
    };
  }

  const now = Date.now();
  const ranked: {
    readonly candidate: (typeof capacityCompatible)[number];
    readonly score: number;
  }[] = [];
  for (const candidate of capacityCompatible) {
    if (candidate.priceVersionId === null) {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: 'missing-price',
      };
    }
    const exactModelReference =
      candidate.resolvedModelId === null
        ? undefined
        : composeModelReference(candidate.resolvedModelId, candidate.revision);
    if (
      candidate.joinedPriceVersionId !== candidate.priceVersionId ||
      candidate.joinedPriceModelReference !== exactModelReference ||
      candidate.joinedPriceProvider !== candidate.providerSlug
    ) {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: 'price-identity-mismatch',
      };
    }
    if (candidate.joinedPriceStatus !== 'active') {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: 'price-inactive',
      };
    }
    if (
      candidate.joinedPriceEffectiveFrom === null ||
      candidate.joinedPriceEffectiveFrom.getTime() > now ||
      (candidate.joinedPriceEffectiveUntil !== null &&
        candidate.joinedPriceEffectiveUntil.getTime() <= now)
    ) {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: 'price-not-effective',
      };
    }
    const score = routingScoreFor(candidate, optimiseFor, now);
    if (score.status === 'unavailable') {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason: score.reason,
      };
    }
    ranked.push({ candidate, score: score.value });
  }

  ranked.sort((left, right) => {
    if (constraints.byokPreference === 'prefer') {
      const leftIsByok = left.candidate.availabilityScope === 'byok_only';
      const rightIsByok = right.candidate.availabilityScope === 'byok_only';
      if (leftIsByok !== rightIsByok) return leftIsByok ? -1 : 1;
    }
    const byScore = right.score - left.score;
    if (byScore !== 0) return byScore;
    const leftId = left.candidate.internalRouteId;
    const rightId = right.candidate.internalRouteId;
    if (leftId === null || rightId === null) return 0;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  // One mapper for the primary and the alternates, so the two cannot describe
  // the same row differently — the reason `CONSTRAINT_COLUMNS` is shared, one
  // level up. `resolvedModelId` and `priceVersionId` are parameters rather than
  // read off the row because each caller has already narrowed them from
  // `string | null`, in the way its own arm requires.
  const edgeRouteOf = (
    row: (typeof capacityCompatible)[number],
    resolvedModelId: string,
    internalRouteId: string,
    priceVersionId: string,
    routingScore: number
  ): EdgeRoute => ({
    deploymentId: internalRouteId,
    routingScore,
    modelReference: composeModelReference(resolvedModelId, row.revision),
    provider: row.providerSlug,
    regions: row.regions,
    availabilityScope: row.availabilityScope as AvailabilityScope,
    priceVersionId,
    ...(row.customerProviderCredential === undefined
      ? {}
      : { customerProviderCredential: row.customerProviderCredential }),
    maxContextTokens: row.maxContextTokens,
    maxOutputTokens: row.maxOutputTokens,
    inputModalities: row.inputModalities,
    outputModalities: row.outputModalities,
  });

  const chosen = ranked[0];
  if (chosen === undefined) {
    return {
      status: 'routing-evidence-unavailable',
      modelReference,
      reason: 'missing-score',
    };
  }
  if (chosen.candidate.resolvedModelId === null) {
    return { status: 'unknown-model', modelReference };
  }

  if (chosen.candidate.internalRouteId === null || chosen.candidate.priceVersionId === null) {
    return {
      status: 'routing-evidence-unavailable',
      modelReference,
      reason: 'missing-exact-deployment-id',
    };
  }

  const alternates: EdgeRoute[] = [];
  for (const { candidate, score } of ranked.slice(1)) {
    const { resolvedModelId, internalRouteId, priceVersionId } = candidate;
    if (resolvedModelId === null || internalRouteId === null || priceVersionId === null) {
      return {
        status: 'routing-evidence-unavailable',
        modelReference,
        reason:
          internalRouteId === null ? 'missing-exact-deployment-id' : 'missing-price',
      };
    }
    alternates.push(
      edgeRouteOf(candidate, resolvedModelId, internalRouteId, priceVersionId, score)
    );
  }

  return {
    status: 'resolved',
    route: edgeRouteOf(
      chosen.candidate,
      chosen.candidate.resolvedModelId,
      chosen.candidate.internalRouteId,
      chosen.candidate.priceVersionId,
      chosen.score
    ),
    alternates,
  };
}

type RoutingScoreResolution =
  | { readonly status: 'available'; readonly value: number }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'missing-score'
        | 'stale-score'
        | 'score-price-mismatch'
        | 'unsupported-optimisation';
    };

function routingScoreFor(
  candidate: {
    readonly internalRouteId: string | null;
    readonly scoreDeploymentId: string | null;
    readonly priceVersionId: string | null;
    readonly scorePriceVersionId: string | null;
    readonly priceScore: number | null;
    readonly latencyScore: number | null;
    readonly latencyMeasurementWindowEnd: Date | null;
    readonly latencyValidUntil: Date | null;
    readonly throughputScore: number | null;
    readonly throughputMeasurementWindowEnd: Date | null;
    readonly throughputValidUntil: Date | null;
    readonly balancedScore: number | null;
    readonly balancedValidUntil: Date | null;
  },
  optimiseFor: RoutingPolicy['optimiseFor'] | RoutingProfile['optimiseFor'],
  now: number
): RoutingScoreResolution {
  if (
    candidate.internalRouteId === null ||
    candidate.scoreDeploymentId !== candidate.internalRouteId
  ) {
    return { status: 'unavailable', reason: 'missing-score' };
  }
  if (
    candidate.priceVersionId === null ||
    candidate.scorePriceVersionId !== candidate.priceVersionId
  ) {
    return { status: 'unavailable', reason: 'score-price-mismatch' };
  }

  if (optimiseFor === 'price') {
    return candidate.priceScore === null
      ? { status: 'unavailable', reason: 'missing-score' }
      : { status: 'available', value: candidate.priceScore };
  }
  if (optimiseFor === 'latency') {
    if (candidate.latencyScore === null) {
      return { status: 'unavailable', reason: 'missing-score' };
    }
    if (
      candidate.latencyMeasurementWindowEnd === null ||
      candidate.latencyMeasurementWindowEnd.getTime() > now ||
      candidate.latencyValidUntil === null ||
      candidate.latencyValidUntil.getTime() <= now
    ) {
      return { status: 'unavailable', reason: 'stale-score' };
    }
    return { status: 'available', value: candidate.latencyScore };
  }
  if (optimiseFor === 'throughput') {
    if (candidate.throughputScore === null) {
      return { status: 'unavailable', reason: 'missing-score' };
    }
    if (
      candidate.throughputMeasurementWindowEnd === null ||
      candidate.throughputMeasurementWindowEnd.getTime() > now ||
      candidate.throughputValidUntil === null ||
      candidate.throughputValidUntil.getTime() <= now
    ) {
      return { status: 'unavailable', reason: 'stale-score' };
    }
    return { status: 'available', value: candidate.throughputScore };
  }
  if (optimiseFor === 'balanced') {
    if (candidate.balancedScore === null) {
      return { status: 'unavailable', reason: 'missing-score' };
    }
    if (candidate.balancedValidUntil === null || candidate.balancedValidUntil.getTime() <= now) {
      return { status: 'unavailable', reason: 'stale-score' };
    }
    return { status: 'available', value: candidate.balancedScore };
  }
  return { status: 'unavailable', reason: 'unsupported-optimisation' };
}

/**
 * Deduplicated, sorted modality list for a refusal message.
 *
 * Sorted so the refusal is deterministic — a set iteration order would make the
 * same request produce two different messages, which is the kind of thing a
 * customer opens a ticket about and a test cannot pin.
 */
function sortedModalities(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/* -------------------------------------------------------------------------- */
/*  Routing profiles — a separate collection, deliberately                    */
/* -------------------------------------------------------------------------- */

/**
 * Every routing profile, with its candidates.
 *
 * Served from its own collection with its own identifier space, and rendered in
 * its own section of Console. A profile is not a model and is never listed
 * among models — that separation is the whole of ADR 0008's sixth concept, and
 * merging the two lists is how `alia-lite` became a "model" in the first place.
 */
export async function listRoutingProfiles(): Promise<RoutingProfile[]> {
  const db = getDb();

  const profileRows = await db
    .select({
      id: inferenceRoutingProfiles.id,
      slug: inferenceRoutingProfiles.slug,
      displayName: inferenceRoutingProfiles.displayName,
      description: inferenceRoutingProfiles.description,
      optimiseFor: inferenceRoutingProfiles.optimiseFor,
      isProductPreset: inferenceRoutingProfiles.isProductPreset,
    })
    .from(inferenceRoutingProfiles)
    .orderBy(asc(inferenceRoutingProfiles.slug));

  if (profileRows.length === 0) return [];

  const candidateRows = await db
    .select({
      routingProfileId: inferenceRoutingProfileCandidates.routingProfileId,
      priority: inferenceRoutingProfileCandidates.priority,
      /** Set on the UNPINNED form: follow this model's current revision. */
      unpinnedModelId: inferenceRoutingProfileCandidates.modelId,
      /** Set on the PINNED form, together with the two columns below. */
      pinnedRevision: inferenceModelRevisions.revision,
      pinnedRevisionModelId: inferenceModelRevisions.modelId,
    })
    .from(inferenceRoutingProfileCandidates)
    .leftJoin(
      inferenceModelRevisions,
      eq(inferenceRoutingProfileCandidates.modelRevisionId, inferenceModelRevisions.id)
    )
    .where(
      inArray(
        inferenceRoutingProfileCandidates.routingProfileId,
        profileRows.map((profile) => profile.id)
      )
    )
    .orderBy(asc(inferenceRoutingProfileCandidates.priority));

  // Both forms of candidate resolve to a MODEL row, whose generated `model_id`
  // is the canonical `<publisher>/<model>`. Resolved in one lookup rather than a
  // conditional join, because a `coalesce` inside a join predicate is exactly
  // the shape `CONVENTIONS.md` warns renders a bare column name and silently
  // matches the wrong table.
  const referencedModelRowIds = [
    ...new Set(
      candidateRows.flatMap((candidate) =>
        candidate.unpinnedModelId !== null
          ? [candidate.unpinnedModelId]
          : candidate.pinnedRevisionModelId !== null
            ? [candidate.pinnedRevisionModelId]
            : []
      )
    ),
  ];
  const canonicalModelIds = new Map(
    referencedModelRowIds.length === 0
      ? []
      : (
          await db
            .select({ id: inferenceModels.id, modelId: inferenceModels.modelId })
            .from(inferenceModels)
            .where(inArray(inferenceModels.id, referencedModelRowIds))
        ).map((row) => [row.id, row.modelId] as const)
  );

  return profileRows.flatMap((profile) => {
    const candidates = candidateRows
      .filter((candidate) => candidate.routingProfileId === profile.id)
      .flatMap((candidate) => {
        const modelRowId = candidate.unpinnedModelId ?? candidate.pinnedRevisionModelId;
        const canonicalModelId =
          modelRowId === null ? undefined : canonicalModelIds.get(modelRowId);
        if (canonicalModelId === undefined || canonicalModelId === null) return [];
        return [
          {
            modelReference:
              candidate.pinnedRevision === null
                ? canonicalModelId
                : composeModelReference(canonicalModelId, candidate.pinnedRevision),
            priority: candidate.priority,
          },
        ];
      });

    // `routingProfileSchema` requires at least one candidate. A profile with
    // none cannot be served and is omitted rather than emitted malformed —
    // the same default-deny reading a model with no current revision gets.
    if (candidates.length === 0) return [];

    return [
      routingProfileSchema.parse({
        schemaVersion: 1 as const,
        routingProfileId: profile.id,
        slug: profile.slug,
        displayName: profile.displayName,
        ...(profile.description === null ? {} : { description: profile.description }),
        optimiseFor: profile.optimiseFor,
        candidates,
        isProductPreset: profile.isProductPreset,
      }),
    ];
  });
}
export type EdgeRoutingProfileResolution =
  | { readonly status: 'resolved'; readonly profile: RoutingProfile }
  | { readonly status: 'unknown-profile' }
  | {
      readonly status: 'routing-evidence-unavailable';
      readonly reason: 'missing-profile-candidate' | 'invalid-profile-candidate';
    };

/**
 * Resolve one routing profile for execution without the public catalogue's
 * default-deny omission semantics.
 *
 * `listRoutingProfiles` may omit a malformed catalogue entry because returning a
 * smaller customer-visible list grants nothing. Execution is different: silently
 * narrowing a named profile changes the set the caller authorized. Every stored
 * candidate is therefore converted explicitly here, and one unresolvable row
 * refuses the whole profile before a reservation or Kaana call.
 */
async function resolveRoutingProfileForEdgeWhere(
  profileWhere: SQL<unknown>
): Promise<EdgeRoutingProfileResolution> {
  const db = getDb();
  const [profile] = await db
    .select({
      id: inferenceRoutingProfiles.id,
      slug: inferenceRoutingProfiles.slug,
      displayName: inferenceRoutingProfiles.displayName,
      description: inferenceRoutingProfiles.description,
      optimiseFor: inferenceRoutingProfiles.optimiseFor,
      isProductPreset: inferenceRoutingProfiles.isProductPreset,
    })
    .from(inferenceRoutingProfiles)
    .where(profileWhere)
    .limit(1);
  if (profile === undefined) return { status: 'unknown-profile' };

  const candidateRows = await db
    .select({
      priority: inferenceRoutingProfileCandidates.priority,
      unpinnedModelId: inferenceRoutingProfileCandidates.modelId,
      pinnedRevisionId: inferenceRoutingProfileCandidates.modelRevisionId,
      pinnedRevision: inferenceModelRevisions.revision,
      pinnedRevisionModelId: inferenceModelRevisions.modelId,
    })
    .from(inferenceRoutingProfileCandidates)
    .leftJoin(
      inferenceModelRevisions,
      eq(inferenceRoutingProfileCandidates.modelRevisionId, inferenceModelRevisions.id)
    )
    .where(eq(inferenceRoutingProfileCandidates.routingProfileId, profile.id))
    .orderBy(asc(inferenceRoutingProfileCandidates.priority));
  if (candidateRows.length === 0) {
    return { status: 'routing-evidence-unavailable', reason: 'missing-profile-candidate' };
  }

  const referencedModelRowIds: string[] = [];
  for (const candidate of candidateRows) {
    const modelRowId = candidate.unpinnedModelId ?? candidate.pinnedRevisionModelId;
    if (modelRowId === null) {
      return { status: 'routing-evidence-unavailable', reason: 'invalid-profile-candidate' };
    }
    referencedModelRowIds.push(modelRowId);
  }
  const canonicalModelIds = new Map(
    (
      await db
        .select({ id: inferenceModels.id, modelId: inferenceModels.modelId })
        .from(inferenceModels)
        .where(inArray(inferenceModels.id, [...new Set(referencedModelRowIds)]))
    ).map((row) => [row.id, row.modelId] as const)
  );

  const candidates: RoutingProfile['candidates'][number][] = [];
  for (const candidate of candidateRows) {
    const modelRowId = candidate.unpinnedModelId ?? candidate.pinnedRevisionModelId;
    const canonicalModelId =
      modelRowId === null ? undefined : canonicalModelIds.get(modelRowId);
    const pinnedCandidate = candidate.pinnedRevisionId !== null;
    if (
      canonicalModelId === undefined ||
      canonicalModelId === null ||
      (pinnedCandidate && candidate.pinnedRevision === null)
    ) {
      return { status: 'routing-evidence-unavailable', reason: 'invalid-profile-candidate' };
    }
    candidates.push({
      modelReference: pinnedCandidate
        ? composeModelReference(canonicalModelId, candidate.pinnedRevision as string)
        : canonicalModelId,
      priority: candidate.priority,
    });
  }

  const parsed = routingProfileSchema.safeParse({
    schemaVersion: 1 as const,
    routingProfileId: profile.id,
    slug: profile.slug,
    displayName: profile.displayName,
    ...(profile.description === null ? {} : { description: profile.description }),
    optimiseFor: profile.optimiseFor,
    candidates,
    isProductPreset: profile.isProductPreset,
  });
  return parsed.success
    ? { status: 'resolved', profile: parsed.data }
    : { status: 'routing-evidence-unavailable', reason: 'invalid-profile-candidate' };
}

/** Resolve the existing public compatibility selector by its canonical slug. */
export function resolveRoutingProfileForEdge(
  slug: string
): Promise<EdgeRoutingProfileResolution> {
  return resolveRoutingProfileForEdgeWhere(eq(inferenceRoutingProfiles.slug, slug));
}

/**
 * Resolve a product integration's exact opaque routing-profile database ID.
 *
 * This is deliberately a primary-key equality lookup. It never falls back to a
 * slug, display name, sort position, or "first" profile when the supplied ID is
 * unknown — an unknown or whitespace-modified ID therefore fails closed.
 */
export function resolveRoutingProfileForEdgeById(
  routingProfileId: string
): Promise<EdgeRoutingProfileResolution> {
  return resolveRoutingProfileForEdgeWhere(
    eq(inferenceRoutingProfiles.id, routingProfileId)
  );
}
