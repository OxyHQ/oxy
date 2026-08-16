/**
 * The canonical model catalogue — reads, the serving boundary, and the
 * commercial-permission gate.
 *
 * Issue #972, workstreams 5 and 11. Decided in
 * `docs/adr/0008-catalogue-concept-separation.md`; the wire shapes are
 * `@oxyhq/contracts`' `inference/catalogue.ts`.
 *
 * Three things live here and nowhere else:
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
 *  3. **The customer-safe projection.** The serializer's INPUT TYPE is derived
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
import type { AvailabilityScope, ModelCatalogueEntry, RoutingProfile } from '@oxyhq/contracts';
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
 * The Application types that see the internal catalogue.
 *
 * `first_party` is deliberately ABSENT. Console and Accounts are first-party and
 * customer-facing: handing them the internal audience would put internal-only
 * routes into the model list a customer reads, which is precisely the
 * separation between "available to Alia internally" and "available to external
 * Oxy customers" that workstream 11 exists to draw.
 */
const INTERNAL_APPLICATION_TYPES = ['internal', 'system'] as const;

/** The subset of an `Application` row this decision reads. */
export interface CatalogueApplicationPrincipal {
  readonly type: string | null;
  readonly isInternal: boolean | null;
}

/**
 * Turn an authenticated principal into a viewer.
 *
 * `undefined` — no application principal at all, i.e. an anonymous caller or a
 * plain user bearer — resolves to the PUBLIC viewer, not to a privileged one.
 * That is the default-deny direction: the way to see more is to present an
 * internal application credential, never to present nothing.
 */
export function resolveCatalogueViewer(
  application: CatalogueApplicationPrincipal | undefined
): CatalogueViewer {
  if (application === undefined) return PUBLIC_CATALOGUE_VIEWER;

  const isInternal =
    application.isInternal === true ||
    (application.type !== null &&
      (INTERNAL_APPLICATION_TYPES as readonly string[]).includes(application.type));

  if (!isInternal) return PUBLIC_CATALOGUE_VIEWER;

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
/*  3. The customer-safe projection                                           */
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
 * Resolve a customer's model reference to a route they may actually be served.
 *
 * Accepts both forms `modelReferenceSchema` admits: `<publisher>/<model>`
 * resolves to the model's current revision, `<publisher>/<model>@<revision>`
 * resolves to exactly those weights or to nothing. A pinned request is never
 * substituted — that is the ADR's rule, and it is why the pinned branch below
 * has no fallback to the current revision.
 *
 * Returns `undefined` when no route qualifies. Callers must treat that as a
 * refusal, never as "pick something else": an internal-only route being
 * invisible to a public credential and a model not existing at all are
 * deliberately the same answer, so the catalogue is not an oracle for what Oxy
 * runs internally.
 */
export async function selectRouteForViewer(
  viewer: CatalogueViewer,
  modelReference: string
): Promise<SelectedRoute | undefined> {
  if (viewer.scopes.length === 0) return undefined;

  const separator = modelReference.indexOf('@');
  const modelId = separator === -1 ? modelReference : modelReference.slice(0, separator);
  const pinnedRevision = separator === -1 ? undefined : modelReference.slice(separator + 1);

  const db = getDb();

  const rows = await db
    .select({
      providerSlug: inferenceDeployments.providerSlug,
      regions: inferenceDeployments.regions,
      availabilityScope: inferenceDeployments.availabilityScope,
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

  const chosen = candidates[0];
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
 */
export type EdgeRouteResolution =
  | { readonly status: 'resolved'; readonly route: EdgeRoute }
  | { readonly status: 'unknown-model'; readonly modelReference: string }
  | { readonly status: 'unpriced-route'; readonly modelReference: string };

/**
 * Resolve a customer's model reference to the route the edge may admit against.
 *
 * Same rules as {@link selectRouteForViewer} — both reference forms, no
 * substitution of a pinned revision, no fallback when nothing qualifies — and
 * the same single selectability predicate. What differs is only that this one
 * also reports the price version and the model's ceilings.
 */
export async function resolveEdgeRoute(
  viewer: CatalogueViewer,
  modelReference: string
): Promise<EdgeRouteResolution> {
  if (viewer.scopes.length === 0) {
    return { status: 'unknown-model', modelReference };
  }

  const separator = modelReference.indexOf('@');
  const modelId = separator === -1 ? modelReference : modelReference.slice(0, separator);
  const pinnedRevision = separator === -1 ? undefined : modelReference.slice(separator + 1);

  const rows = await getDb()
    .select({
      providerSlug: inferenceDeployments.providerSlug,
      availabilityScope: inferenceDeployments.availabilityScope,
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

  const chosen = candidates[0];
  if (chosen === undefined || chosen.resolvedModelId === null) {
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
