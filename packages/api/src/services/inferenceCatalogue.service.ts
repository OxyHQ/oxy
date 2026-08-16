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
 * Relay remains the source of technical deployment health and route
 * availability (ADR 0006). Nothing here reports whether a route is answering
 * right now; `status` is the catalogue's own decision about whether a route may
 * be OFFERED, which is a different question. Collapsing the two is what the
 * retired `models-stats.ts` did with its literal `isHealthy: true`.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  AvailabilityScope,
  ModelCatalogueEntry,
  RoutingPolicy,
  RoutingProfile,
} from '@oxyhq/contracts';
import { modelCatalogueEntrySchema, routingProfileSchema } from '@oxyhq/contracts';
import type { SelectedRow } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import {
  inferenceDeployments,
  inferenceModelEvaluations,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
  SELECTABLE_PERMISSION_STATE,
} from '../db/schema';
import {
  classifyApplicationTier,
  type ApplicationClassification,
} from '../utils/applicationTier';

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
 * - `byok_only` needs a validated BYOK provider connection for the calling
 *   account, which is workstream 10 and does not exist. A BYOK route with no
 *   connection behind it cannot be served at all, so offering it would be a
 *   catalogue entry that 500s.
 *
 * `schema/__tests__`/the service tests assert no viewer produces either, so
 * this stays true until somebody deliberately changes it.
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
 * The `internal` TIER is the one `classifyApplicationTier` computes, shared with
 * the inference edge's rollout audience so the two cannot come to different
 * answers about the same row. `first_party` is deliberately not internal here:
 * Console and Accounts are first-party and customer-facing, and handing them the
 * internal audience would put internal-only routes into the model list a
 * customer reads.
 */
export function resolveCatalogueViewer(
  application: CatalogueApplicationPrincipal | undefined
): CatalogueViewer {
  if (classifyApplicationTier(application) !== 'internal') return PUBLIC_CATALOGUE_VIEWER;

  return {
    scopes: [...PUBLIC_CATALOGUE_SCOPES, 'internal_alia'],
    label: 'internal',
  };
}

/* -------------------------------------------------------------------------- */
/*  2. The one selectability predicate                                        */
/* -------------------------------------------------------------------------- */

/**
 * Catalogue statuses under which a route may still be offered.
 *
 * `degraded` is included: it means "offer it with a warning", not "it is timing
 * out" — which is Relay's signal, and not stored here. `disabled` and `retired`
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
 * an `internal_alia` route with `permission_state = 'pending_review'` is
 * invisible to Alia too. That costs one staff approval per internal route and
 * buys a gate with no branch in it.
 */
function selectableDeploymentWhere(viewer: CatalogueViewer) {
  return and(
    inArray(inferenceDeployments.availabilityScope, [...viewer.scopes]),
    eq(inferenceDeployments.permissionState, SELECTABLE_PERMISSION_STATE),
    inArray(inferenceDeployments.status, [...OFFERABLE_STATUSES])
  );
}

/**
 * A total order over availability scopes, used to pick the ONE route whose
 * commercial terms an entry reports.
 *
 * A catalogue entry carries a single `availabilityScope` and
 * `commercialPermission` while a model may be offered on several routes, so
 * something has to choose. An arbitrary choice would make the same model report
 * different terms on different reads, which is worse than a rule somebody
 * disagrees with — so the rule is declared here, once, and is deterministic:
 * the most customer-facing terms first, ties broken by provider slug.
 */
const SCOPE_PRIMACY: readonly AvailabilityScope[] = [
  'public_payg',
  'oxy_hosted',
  'enterprise',
  'internal_alia',
  'byok_only',
];

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
    'ENFORCED, in `inferenceRoutingPolicy.service.ts`’s `recordRouteSwitch`: a substitution is refused unless the destination is named in the version’s authorisation rows. It governs a SWITCH between routes, not the qualification of one, so it cannot be expressed as a predicate over a single candidate.',
  optimiseFor:
    'A RANKING among the routes that already qualify, which is routing EXECUTION and therefore the data plane’s (ADR 0006). It can never exclude a candidate, so enforcing it here would mean inventing a routing decision the control plane has no way to test.',
  maxPricePerUnit:
    'INERT, and it needs a different mechanism: the price of a candidate lives on `price_version_unit_prices`, which the LEDGER owns, and comparing exact decimals is arithmetic this repo does exclusively in SQL (`inferenceLedger.service.ts`’s `computeCharge`). A ceiling also has to decide what an unpriced route and a foreign-currency ceiling mean. Issue #1011 reports it rather than half-enforcing it.',
  maxPricePerRequest:
    'INERT, and it cannot be a candidate filter at all: what a REQUEST costs is only known once the request’s own unit ceiling has been estimated, which happens after a route is chosen and priced. Its home is the edge, beside `quoteUnits`.',
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
 * prohibition can withhold a route a request could otherwise be served today:
 * `byok_only` is in {@link UNGRANTABLE_SCOPES}, and a deployment with
 * `dedicated_capacity` holds capacity reserved for ONE enterprise account, which
 * an application with no policy of its own was never entitled to.
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
} as const;

/**
 * Which of a policy's constraints this candidate fails — ALL of them, in the
 * order written below, so a refusal can say what would have to change.
 *
 * Every list-valued control has an EXPLICIT empty branch rather than a bare
 * containment test: `[].includes(x)` is false for every `x`, so an empty
 * allow-list written as plain membership would exclude every candidate, which is
 * the opposite of the contract's "empty means no allowlist".
 */
export function violatedConstraints(
  constraints: RoutingConstraints,
  candidate: ConstrainedCandidate
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
  // Never vacuously true over an empty array: `regions` carries a
  // `cardinality(...) >= 1` CHECK.
  if (
    constraints.allowedRegions.length > 0 &&
    !candidate.regions.every((region) => constraints.allowedRegions.includes(region))
  ) {
    violated.push('allowedRegions');
  }

  if (candidate.regions.some((region) => constraints.deniedRegions.includes(region))) {
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

function applyRoutingConstraints<T extends ConstrainedCandidate>(
  constraints: RoutingConstraints,
  candidates: readonly T[]
): ConstrainedCandidates<T> {
  const kept: T[] = [];
  const excludedBy: RoutingConstraint[] = [];

  for (const candidate of candidates) {
    const violated = violatedConstraints(constraints, candidate);
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

/**
 * The customer-safe data policy, from a deployment row.
 *
 * Reads the DEPLOYMENT's policy rather than the provider organisation's,
 * because a routing policy is enforced against the ROUTE: a zero-retention
 * endpoint from a provider whose default retains is a real and important case,
 * and reporting the organisation's default there would tell a customer their
 * data is retained when it is not.
 */
function dataPolicyOf(deployment: CustomerSafeDeploymentRow) {
  return {
    retainsPayloads: deployment.retainsPayloads,
    retentionDays: deployment.retentionDays,
    trainsOnCustomerData: deployment.trainsOnCustomerData,
    zeroDataRetentionAvailable: deployment.zeroDataRetentionAvailable,
    subprocessors: deployment.subprocessors ?? [],
    ...(deployment.policyUrl === null ? {} : { policyUrl: deployment.policyUrl }),
  };
}

/**
 * Build one customer-facing catalogue entry.
 *
 * Every parameter is already narrowed to a customer-safe shape, so this
 * function has no opportunity to leak: `deployments` is
 * `CustomerSafeDeploymentRow[]`, whose type has no internal route id and no
 * wholesale cost to read. The `.parse()` at the end is the second, runtime
 * guard — it strips anything unknown and fails loudly on anything malformed.
 *
 * `pricing` is deliberately never populated yet: price versions are the
 * LEDGER's table (workstream 7) and it has not landed. An entry with no
 * `pricing` says "we have not published a price for this"; an invented one
 * would be quoted back to us.
 */
function buildCatalogueEntry(
  model: CatalogueModelRow,
  currentRevision: CatalogueRevisionRow,
  availableRevisions: readonly CatalogueRevisionRow[],
  deployments: readonly CustomerSafeDeploymentRow[],
  providersBySlug: ReadonlyMap<string, CatalogueProviderRow>,
  evaluations: readonly { suite: string; metric: string; score: string; evaluatedAt: Date | null; reportUrl: string | null }[]
): ModelCatalogueEntry | null {
  if (model.modelId === null || deployments.length === 0) return null;

  // The route whose commercial terms this entry reports. Deterministic: the
  // most customer-facing scope first, then provider slug. See SCOPE_PRIMACY.
  const primary = [...deployments].sort((left, right) => {
    const byScope =
      SCOPE_PRIMACY.indexOf(left.availabilityScope as AvailabilityScope) -
      SCOPE_PRIMACY.indexOf(right.availabilityScope as AvailabilityScope);
    return byScope !== 0 ? byScope : left.providerSlug.localeCompare(right.providerSlug);
  })[0];

  const regions = [...new Set(deployments.flatMap((deployment) => deployment.regions))].sort();

  const servingProviders = [...new Set(deployments.map((deployment) => deployment.providerSlug))]
    .sort()
    .flatMap((slug) => {
      const provider = providersBySlug.get(slug);
      const deployment = deployments.find((candidate) => candidate.providerSlug === slug);
      if (provider === undefined || deployment === undefined) return [];
      return [
        {
          slug: provider.slug,
          displayName: provider.displayName,
          regions: [...deployment.regions].sort(),
          dataPolicy: dataPolicyOf(deployment),
        },
      ];
    });

  const entry = {
    schemaVersion: 1 as const,
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
    dataPolicy: dataPolicyOf(primary),
    availabilityScope: primary.availabilityScope,
    commercialPermission: primary.commercialPermission,
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
      // parameter type is `CustomerSafeDeploymentRow` and therefore cannot read
      // this even though the query returns it.
      joinModelId: inferenceModelRevisions.modelId,
      joinRevisionId: inferenceModelRevisions.id,
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
      evaluationRows.filter((row) => row.modelRevisionId === currentRevision.id)
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
  if (viewer.scopes.length === 0) return undefined;

  const separator = modelReference.indexOf('@');
  const modelId = separator === -1 ? modelReference : modelReference.slice(0, separator);
  const pinnedRevision = separator === -1 ? undefined : modelReference.slice(separator + 1);

  const db = getDb();

  const rows = await db
    .select({
      ...CONSTRAINT_COLUMNS,
      revision: inferenceModelRevisions.revision,
      isCurrent: inferenceModelRevisions.isCurrent,
      retiredAt: inferenceModelRevisions.retiredAt,
      resolvedModelId: inferenceModels.modelId,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .where(and(selectableDeploymentWhere(viewer), eq(inferenceModels.modelId, modelId)))
    .orderBy(asc(inferenceDeployments.providerSlug));

  const candidates = rows.filter((row) => {
    if (row.retiredAt !== null) return false;
    return pinnedRevision === undefined ? row.isCurrent : row.revision === pinnedRevision;
  });

  const chosen = applyRoutingConstraints(constraints, candidates).kept[0];
  if (chosen === undefined || chosen.resolvedModelId === null) return undefined;

  return {
    modelReference: composeModelReference(chosen.resolvedModelId, chosen.revision),
    provider: chosen.providerSlug,
    regions: chosen.regions,
    availabilityScope: chosen.availabilityScope as AvailabilityScope,
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
 *    it cannot be admitted — see {@link EdgeRouteResolution}'s `unpriced-route`.
 *  - `maxContextTokens` / `maxOutputTokens`, because a request that cannot fit is
 *    refused AT THE EDGE rather than forwarded and paid for. Inheriting whatever
 *    the upstream provider happens to enforce is how a customer is billed for a
 *    request that was never going to succeed.
 *
 * It goes through {@link selectableDeploymentWhere} like every other read, so an
 * admission can never reach a route the catalogue would not offer.
 */
export interface EdgeRoute {
  /** `<publisher>/<model>@<revision>` — always revision-pinned. */
  readonly modelReference: string;
  readonly provider: string;
  readonly availabilityScope: AvailabilityScope;
  /** The price version a hold is sized against and a receipt is settled at. */
  readonly priceVersionId: string;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Outcome of {@link resolveEdgeRoute}.
 *
 * `unknown-model` and `unpriced-route` are separate arms because they are
 * different platform facts and only one of them is the customer's to act on: a
 * model that does not exist (or that this viewer may not see) is a request
 * error, while a route Oxy has published without a price is an Oxy
 * configuration gap. Collapsing them would tell a customer to fix a model id
 * that was correct.
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
  | { readonly status: 'resolved'; readonly route: EdgeRoute }
  | { readonly status: 'unknown-model'; readonly modelReference: string }
  | { readonly status: 'unpriced-route'; readonly modelReference: string }
  | {
      readonly status: 'policy-excluded';
      readonly modelReference: string;
      /** Non-empty by construction. Deterministically ordered. */
      readonly constraints: readonly RoutingConstraint[];
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
  constraints: RoutingConstraints
): Promise<EdgeRouteResolution> {
  if (viewer.scopes.length === 0) {
    return { status: 'unknown-model', modelReference };
  }

  const separator = modelReference.indexOf('@');
  const modelId = separator === -1 ? modelReference : modelReference.slice(0, separator);
  const pinnedRevision = separator === -1 ? undefined : modelReference.slice(separator + 1);

  const rows = await getDb()
    .select({
      ...CONSTRAINT_COLUMNS,
      priceVersionId: inferenceDeployments.priceVersionId,
      revision: inferenceModelRevisions.revision,
      isCurrent: inferenceModelRevisions.isCurrent,
      retiredAt: inferenceModelRevisions.retiredAt,
      resolvedModelId: inferenceModels.modelId,
      maxContextTokens: inferenceModels.maxContextTokens,
      maxOutputTokens: inferenceModels.maxOutputTokens,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .where(and(selectableDeploymentWhere(viewer), eq(inferenceModels.modelId, modelId)))
    .orderBy(asc(inferenceDeployments.providerSlug));

  const candidates = rows.filter((row) => {
    if (row.retiredAt !== null) return false;
    return pinnedRevision === undefined ? row.isCurrent : row.revision === pinnedRevision;
  });

  if (candidates.length === 0) {
    return { status: 'unknown-model', modelReference };
  }

  const permitted = applyRoutingConstraints(constraints, candidates);
  if (permitted.kept.length === 0) {
    // Refuse, and say what refused. Never widen back to a candidate the policy
    // excluded, and never answer as though the request had been unconstrained —
    // a request that cannot be served under its own policy is a refusal, not a
    // downgrade.
    return { status: 'policy-excluded', modelReference, constraints: permitted.excludedBy };
  }

  const chosen = permitted.kept[0];
  if (chosen.resolvedModelId === null) {
    return { status: 'unknown-model', modelReference };
  }

  if (chosen.priceVersionId === null) {
    return { status: 'unpriced-route', modelReference };
  }

  return {
    status: 'resolved',
    route: {
      modelReference: composeModelReference(chosen.resolvedModelId, chosen.revision),
      provider: chosen.providerSlug,
      availabilityScope: chosen.availabilityScope as AvailabilityScope,
      priceVersionId: chosen.priceVersionId,
      maxContextTokens: chosen.maxContextTokens,
      maxOutputTokens: chosen.maxOutputTokens,
    },
  };
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
