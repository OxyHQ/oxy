/**
 * `inference_deployments` — one concrete servable route.
 *
 * The fifth of ADR 0008's six concepts, and the only one a routing policy ever
 * filters: a REVISION, on a PROVIDER, in some REGIONS, under a data policy, with
 * an availability scope and a commercial permission. Two deployments of the SAME
 * revision are what same-model failover moves between; moving to a deployment of
 * a different revision or model is a cross-model fallback and needs explicit
 * authorization.
 *
 * ## Default deny is a column default, not a convention (workstream 11)
 *
 * A technically callable provider route is not automatically publicly
 * resellable. `permission_state` therefore defaults to `pending_review` and
 * `status` to `disabled`, so a route inserted by ANY path — a seed script, an
 * import, a `psql` session, a future admin UI with a bug — is unselectable until
 * somebody deliberately approves it. The read path (`inferenceCatalogue.service.ts`)
 * has exactly one predicate for selectability and it requires `approved`; there
 * is no "internal routes are exempt" branch, because that branch is where an
 * exemption would silently widen.
 *
 * Approving requires the legal review to have been approved first, and a legal
 * approval requires a non-blank evidence reference. Both are CHECKs below: the
 * cheapest way to satisfy them is to do the review, which is the point.
 *
 * ## What is NOT here, and must never be
 *
 * - **Provider credentials of any kind.** Kaana encrypts BYOK credentials in
 *   its PostgreSQL database with KMS and resolves them only inside inference;
 *   Oxy stores only metadata plus the opaque exact handle/revision.
 * - **Route health.** Kaana owns technical deployment health and availability
 *   (ADR 0006). `status` here is the CATALOGUE's decision about whether a route
 *   may be offered at all, which is a different question from whether it is
 *   answering right now, and the two must not be collapsed — the fake
 *   `isHealthy: true` in the retired `models-stats.ts` is what collapsing them
 *   looks like.
 *
 * ## Three columns are PROTECTED, and the projection is separately allow-listed
 *
 * `internal_route_id`, `legal_review_evidence_ref` and the wholesale-cost group
 * are registered in `protectedColumns.ts`, so `publicColumns()` omits them at
 * the TYPE level and the repo's implicit-whole-row-read scanner covers this
 * table. That is the backstop, not the mechanism: the customer projection is
 * built from an explicit allow-list in the service, so a column added here
 * tomorrow is invisible to customers until somebody names it. See
 * `CUSTOMER_SAFE_DEPLOYMENT_COLUMNS` and the classification test.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  availabilityScopeSchema,
  commercialPermissionSchema,
  INFERENCE_MONEY_SCALE,
  USAGE_UNITS,
} from '@oxyhq/contracts';
import { createdAt, generatedId, inList, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { inferenceProviders } from './inferenceProviders';
import { priceVersions } from './priceVersions';
import { users } from './users';

/**
 * Who a route may be served to. Taken from the contract's own zod enum rather
 * than restated, so the column type, the CHECK and the wire cannot disagree —
 * a value added or renamed upstream changes all three at once.
 */
export const AVAILABILITY_SCOPES = availabilityScopeSchema.options;

/** The commercial basis on which Oxy may serve a route. Same derivation. */
export const COMMERCIAL_PERMISSIONS = commercialPermissionSchema.options;

/**
 * The catalogue's own decision about whether a route may be offered.
 *
 * Distinct from Kaana's health signal, which Oxy does not store: `degraded` here
 * means "offer it with a warning", not "it is timing out right now".
 * Mirrors `modelDeploymentSchema.status`.
 */
export const DEPLOYMENT_STATUSES = ['active', 'degraded', 'disabled', 'retired'] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const APPROVED_INTERNAL_ROUTE_ID_UNIQUE_INDEX =
  'inference_deployments_approved_internal_route_id_key';

/**
 * The approval lifecycle a route moves through (workstream 11's admin workflow).
 *
 * `pending_review` is the DEFAULT and denies everything. `restricted` and
 * `suspended` are both non-selectable and kept distinct because they are
 * different decisions with different exits — `restricted` is a deliberate narrowing
 * pending a further permission, `suspended` is an incident. `retired` is terminal.
 */
export const DEPLOYMENT_PERMISSION_STATES = [
  'pending_review',
  'approved',
  'restricted',
  'suspended',
  'retired',
] as const;

export type DeploymentPermissionState = (typeof DEPLOYMENT_PERMISSION_STATES)[number];

/** The ONE state in which a route may be selected. Read by the service. */
export const SELECTABLE_PERMISSION_STATE = 'approved';

/** Contract/legal review of the right to serve this route. */
export const DEPLOYMENT_LEGAL_REVIEW_STATUSES = [
  'not_started',
  'in_review',
  'approved',
  'rejected',
] as const;

export type DeploymentLegalReviewStatus = (typeof DEPLOYMENT_LEGAL_REVIEW_STATUSES)[number];

/**
 * The commercial permissions that may back a PUBLIC pay-as-you-go route.
 * Mirrors the refinement in `modelDeploymentSchema`.
 */
const PUBLIC_RESALE_PERMISSIONS = [
  'public_resale_approved',
  'wholesale_contract',
  'open_weight_hosting',
] as const;

export const inferenceDeployments = pgTable(
  'inference_deployments',
  {
    id: generatedId(),

    /**
     * The exact weights this route serves. A deployment ALWAYS pins a revision —
     * structurally, because this is a foreign key to the revision table and not
     * a nullable model reference. That is the database's version of the
     * contract's "a deployment must pin an immutable revision" refinement, and
     * it cannot be satisfied by a well-formed string that names nothing.
     *
     * `RESTRICT`: a revision with a live route is not deletable. Cascading would
     * silently delete the route — and with it the record of what a customer was
     * being served — because somebody tidied a revision.
     */
    modelRevisionId: text()
      .notNull()
      .references(() => inferenceModelRevisions.id, { onDelete: 'restrict' }),

    /** Who runs it. `RESTRICT` for the same reason. */
    providerSlug: text()
      .notNull()
      .references(() => inferenceProviders.slug, { onDelete: 'restrict' }),

    /**
     * Where Kaana has ATTESTED that the deployment may run. An empty array is
     * explicit "region not attested", never "global": any routing policy with
     * an allow- or deny-region control excludes it, while an unconstrained
     * policy may still use it.
     */
    regions: text().array().notNull(),

    /* ---- this route's data policy (`inferenceDataPolicySchema`) ---------- */

    retainsPayloads: boolean().notNull(),
    retentionDays: integer().notNull(),
    trainsOnCustomerData: boolean().notNull(),
    zeroDataRetentionAvailable: boolean().notNull(),
    subprocessors: text().array(),
    policyUrl: text(),

    /* ---- commercial position (workstream 11) ----------------------------- */

    availabilityScope: text({ enum: AVAILABILITY_SCOPES }).notNull(),
    commercialPermission: text({ enum: COMMERCIAL_PERMISSIONS }).notNull(),

    /** Default DENY. Nothing is selectable until it is explicitly approved. */
    permissionState: text({ enum: DEPLOYMENT_PERMISSION_STATES })
      .notNull()
      .default('pending_review'),
    permissionStateChangedAt: timestamptz(),
    /**
     * The staff member who last moved the permission state. `SET NULL`: the
     * audit trail must survive that person's account being erased, and the
     * alternative — deleting the route — would be an erasure request silently
     * taking a commercial decision with it.
     */
    permissionStateChangedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Why, in one line. Staff-visible; never part of the customer projection. */
    permissionStateNote: text(),

    legalReviewStatus: text({ enum: DEPLOYMENT_LEGAL_REVIEW_STATUSES })
      .notNull()
      .default('not_started'),
    /**
     * PROTECTED. A POINTER into whatever register holds the contract — a matter
     * reference, an envelope id — and never the contract itself. The epic's
     * requirement is to track review status and evidence "without storing
     * confidential contracts in the catalogue", so this column holds a string
     * that is useless to anyone without access to that register.
     */
    legalReviewEvidenceRef: text(),
    legalReviewedAt: timestamptz(),
    legalReviewedByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    /* ---- operational ----------------------------------------------------- */

    status: text({ enum: DEPLOYMENT_STATUSES }).notNull().default('disabled'),
    /** Reserved capacity for one enterprise account rather than shared. */
    dedicatedCapacity: boolean().notNull().default(false),

    /**
     * The price version customers are charged under on this route.
     *
     * `RESTRICT`, and it will never fire in ordinary operation: price versions
     * are append-only, so retirement is `status = 'superseded'` plus
     * `effective_until`, never a DELETE. It exists for the case that is not
     * ordinary — a price version that priced a live route must not be
     * removable, because the route would then quote a price nothing can
     * reproduce.
     *
     * The column lives HERE rather than on the ledger's side because a price
     * version is scoped to a `(model reference, provider)` pair, which is a
     * property of the ROUTE; putting it there would make the ledger own a
     * catalogue fact. Agreed with that table's owner, along with the converse:
     * `price_versions.model_reference` and `.provider` stay plain `text` with
     * no foreign key back into this catalogue, so a settled receipt stays
     * reproducible after a revision is retired.
     *
     * The catalogue never defines its own money or a second price-version
     * table. The one exception below is an upstream COST, which is not a
     * customer price.
     */
    priceVersionId: text().references(() => priceVersions.id, { onDelete: 'restrict' }),

    /**
     * The separately reviewed Oxy platform-fee price used only when
     * `availability_scope = 'byok_only'`.
     *
     * The upstream provider still bills the customer directly, so
     * `price_version_id` remains NULL for BYOK. This pointer names only Oxy's
     * own fee schedule and is nullable so a draft route can exist before an
     * operator publishes and associates that schedule. An active/approved
     * route without a usable fee remains fail-closed in the edge resolver.
     */
    platformFeePriceVersionId: text().references(() => priceVersions.id, {
      onDelete: 'restrict',
    }),

    /**
     * PROTECTED. The data plane's own identifier for this route.
     *
     * Stored so operations can correlate a catalogue row with what Kaana is
     * running. It is exactly the kind of internal topology the serving boundary
     * says must never reach a customer, even when attribution is permitted:
     * naming the serving PROVIDER is attribution, naming the internal route is
     * a map of the infrastructure.
     */
    internalRouteId: text(),

    /* ---- upstream cost — PROTECTED, and NOT a customer price ------------- */

    /**
     * What Oxy pays upstream, per unit. PROTECTED, and deliberately not part of
     * any customer-facing shape.
     *
     * This is NOT a price version and NOT customer money. The ledger owns
     * `price_versions` and every customer-facing amount; this column exists so
     * staff can review margin against a route's contracted rate, and Kaana
     * remains the authority for MEASURED upstream cost (ADR 0006). Two price
     * authorities is the failure this epic exists to prevent, so nothing reads
     * this in a billing path.
     *
     * `numeric` at {@link INFERENCE_MONEY_SCALE} rather than a float: an exact
     * decimal is the only representation the money contract permits, and
     * postgres.js decodes `numeric` as a STRING, so accidental JS arithmetic on
     * it fails loudly instead of silently losing precision.
     */
    upstreamWholesaleCostAmount: numeric({ precision: 30, scale: INFERENCE_MONEY_SCALE }),
    /** ISO 4217 alpha-3. PROTECTED. */
    upstreamWholesaleCostCurrency: text(),
    /** Which metered unit the cost is quoted per. PROTECTED. */
    upstreamWholesaleCostUnit: text({ enum: USAGE_UNITS }),
    /** How many of that unit the amount covers (providers quote per million). PROTECTED. */
    upstreamWholesaleCostPer: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * One route per `(revision, provider, audience)`.
     *
     * Region is deliberately not part of the key: the contract models a
     * deployment as covering several regions, so two rows differing only by
     * region would be two names for one route. Audience IS part of it, because
     * the same revision on the same provider is legitimately offered to Alia
     * internally and to public customers under different commercial terms —
     * those are two decisions and must be two rows.
     */
    unique('inference_deployments_revision_provider_scope_key').on(
      t.modelRevisionId,
      t.providerSlug,
      t.availabilityScope
    ),
    // Drafts may model audience-specific offers independently. Publication may
    // not: until serving has a viewer-aware cross-scope commercial contract,
    // one exact Kaana deployment identity can back at most one approved row.
    uniqueIndex(APPROVED_INTERNAL_ROUTE_ID_UNIQUE_INDEX)
      .on(t.internalRouteId)
      .where(sql`${t.permissionState} = 'approved' and ${t.internalRouteId} is not null`),

    /* ---- closed value sets ---------------------------------------------- */

    check(
      'inference_deployments_availability_scope_check',
      sql`${t.availabilityScope} in (${sql.raw(inList(AVAILABILITY_SCOPES))})`
    ),
    check(
      'inference_deployments_commercial_permission_check',
      sql`${t.commercialPermission} in (${sql.raw(inList(COMMERCIAL_PERMISSIONS))})`
    ),
    check(
      'inference_deployments_permission_state_check',
      sql`${t.permissionState} in (${sql.raw(inList(DEPLOYMENT_PERMISSION_STATES))})`
    ),
    check(
      'inference_deployments_legal_review_status_check',
      sql`${t.legalReviewStatus} in (${sql.raw(inList(DEPLOYMENT_LEGAL_REVIEW_STATUSES))})`
    ),
    check(
      'inference_deployments_status_check',
      sql`${t.status} in (${sql.raw(inList(DEPLOYMENT_STATUSES))})`
    ),

    /* ---- data-policy coherence ------------------------------------------ */

    check(
      'inference_deployments_retention_coherent',
      sql`${t.retentionDays} >= 0 and ${t.retentionDays} <= 3650 and (${t.retainsPayloads} or ${t.retentionDays} = 0)`
    ),
    check(
      'inference_deployments_training_requires_retention',
      sql`${t.retainsPayloads} or not ${t.trainsOnCustomerData}`
    ),

    /* ---- the commercial refinements from `modelDeploymentSchema` --------- */

    /**
     * A public pay-as-you-go route requires an approved resale permission.
     * Availability inside Alia never implies the right to resell the same
     * provider/model publicly — this is that invariant, in the database.
     */
    check(
      'inference_deployments_public_requires_resale_permission',
      sql`${t.availabilityScope} <> 'public_payg' or ${t.commercialPermission} in (${sql.raw(inList(PUBLIC_RESALE_PERMISSIONS))})`
    ),
    /** A BYOK-only route is served under the customer's own provider terms. */
    check(
      'inference_deployments_byok_permission',
      sql`${t.availabilityScope} <> 'byok_only' or ${t.commercialPermission} = 'customer_byok'`
    ),
    /**
     * A BYOK route has no customer model price: the upstream provider bills the
     * customer directly and Oxy charges only its platform fee, which is not a
     * per-unit model price and does not live on a price version.
     */
    check(
      'inference_deployments_byok_has_no_price_version',
      sql`${t.availabilityScope} <> 'byok_only' or ${t.priceVersionId} is null`
    ),
    /** A platform-fee pointer has meaning only on a BYOK-only route. */
    check(
      'inference_deployments_platform_fee_only_for_byok',
      sql`${t.platformFeePriceVersionId} is null or ${t.availabilityScope} = 'byok_only'`
    ),

    /* ---- the approval gate (workstream 11) ------------------------------ */

    /**
     * A route cannot be APPROVED until its legal review is.
     *
     * The cheapest way to green this is to do the review and record it, which is
     * the behaviour the epic asks for. The alternative shape — a boolean nobody
     * has to set — is greenest when it is left false, and would make "approved"
     * mean only "somebody clicked approve".
     */
    check(
      'inference_deployments_approval_requires_legal_review',
      sql`${t.permissionState} <> 'approved' or ${t.legalReviewStatus} = 'approved'`
    ),
    /**
     * A legal approval must point at its evidence, and at when it happened.
     *
     * `length(btrim(...)) > 0` rather than `is not null`: an empty string is a
     * VALUE and would satisfy a null check, so the cheapest way to green a bare
     * `is not null` would be to write `''` — which records nothing while
     * reading as compliant.
     */
    check(
      'inference_deployments_legal_approval_has_evidence',
      sql`${t.legalReviewStatus} <> 'approved' or (${t.legalReviewedAt} is not null and length(btrim(coalesce(${t.legalReviewEvidenceRef}, ''))) > 0)`
    ),

    /* ---- upstream cost is present as a whole, or not at all -------------- */

    /**
     * An amount with no unit prices nothing, and a unit with no amount says
     * nothing. `num_nonnulls` over the group is the four-way version of the
     * present-or-absent biconditional used for the revision's safety object.
     */
    check(
      'inference_deployments_wholesale_cost_is_whole',
      sql`num_nonnulls(${t.upstreamWholesaleCostAmount}, ${t.upstreamWholesaleCostCurrency}, ${t.upstreamWholesaleCostUnit}, ${t.upstreamWholesaleCostPer}) in (0, 4)`
    ),
    check(
      'inference_deployments_wholesale_cost_shape',
      sql`(${t.upstreamWholesaleCostAmount} is null or ${t.upstreamWholesaleCostAmount} >= 0)
        and (${t.upstreamWholesaleCostPer} is null or ${t.upstreamWholesaleCostPer} > 0)
        and (${t.upstreamWholesaleCostCurrency} is null or ${t.upstreamWholesaleCostCurrency} ~ ${sql.raw(String.raw`'^[A-Z]{3}$'`)})
        and (${t.upstreamWholesaleCostUnit} is null or ${t.upstreamWholesaleCostUnit} = any(${sql.raw(textArrayLiteral(USAGE_UNITS))}))`
    ),

    /* ---- indexes --------------------------------------------------------- */

    /**
     * The public catalogue's own read: every selectable route, by audience.
     * Leads with the two columns every customer-facing query filters on, so the
     * default-deny predicate is an index scan rather than a scan of every route
     * ever proposed.
     *
     * An index is the one thing a functional test can never detect the absence
     * of — a missing one here degrades silently to a sequential scan that grows
     * with the number of REJECTED routes, which is the set that grows fastest.
     */
    index('inference_deployments_scope_permission_status_idx').on(
      t.availabilityScope,
      t.permissionState,
      t.status
    ),
    /** Resolving "which routes serve this revision" for failover and for the entry. */
    index('inference_deployments_model_revision_id_idx').on(t.modelRevisionId),
    /** "Everything on this provider", for an incident and for the admin queue. */
    index('inference_deployments_provider_slug_idx').on(t.providerSlug),
  ]
);

export type InferenceDeploymentRow = typeof inferenceDeployments.$inferSelect;
