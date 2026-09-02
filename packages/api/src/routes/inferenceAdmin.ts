/**
 * The catalogue's staff surface (issue #972, workstream 11).
 *
 * Approving, restricting, suspending and retiring routes, plus recording the
 * contract/legal review that an approval depends on. Staff-gated with
 * `requireStaff`, consistently with how this repo already gates
 * `Application.type` / `isOfficial` / `isInternal` / `capabilities`: a route's
 * commercial permission asserts that OXY has the right to resell somebody
 * else's model, which no customer-held role can know and therefore no
 * customer-held role may grant.
 *
 * The two WRITES are narrower still, as of #972 section 12: they additionally
 * require the graded `inference:catalogue:publish` staff capability
 * (`users.staff_capabilities`), which no staff member holds until an
 * administrator grants it. Being able to read this surface is no longer the same
 * right as being able to publish through it.
 *
 * Reads here return the FULL row, including the fields the customer projection
 * withholds — that is the point of a staff surface. `legal_review_evidence_ref`
 * is a pointer into the contract register and never the contract itself; the
 * wholesale cost is Oxy's own commercial position. Both are named in
 * `protectedColumns.ts`, so every OTHER read path omits them at the type level
 * and this module has to ask for them by name, which is exactly the shape
 * `CONVENTIONS.md` wants an opt-in to have.
 *
 * INTENDED, not built: publishing a price version. `price_versions` is the
 * ledger's table (workstream 7) and is not in this schema barrel yet — see
 * `services/inferenceCatalogueAdmin.service.ts`.
 *
 * Also here, and not a catalogue operation at all: `GET /rollout`, the one place
 * this deployment's rollout flags are readable, and `GET /metrics`, the
 * workstream-16 operational metrics. Both live on this router because they need
 * the same staff gate and nothing weaker, and giving either a mount of its own
 * would be a second staff surface to keep gated correctly.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import {
  modelGpaiDocumentationSchema,
  modelReleaseIngestionRequestSchema,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { describeRolloutFlags } from '../config/rolloutFlags';
import {
  inferenceTokenAnomalies,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceSpendAnomalies,
} from '../db/schema';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { requireStaff, requireStaffCapability } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import {
  deploymentParams,
  kaanaDeploymentParams,
  legalReviewBody,
  metricsQuery,
  permissionActionBody,
  permissionActionParams,
  revisionParams,
  routingScorecardResponse,
  routingScoresBody,
  spendAnomalyQuery,
  tokenAnomalyQuery,
} from '../schemas/inferenceAdmin.schemas';
import {
  applyPermissionAction,
  DeploymentNotFoundError,
  DeploymentPermissionRefused,
  recordLegalReview,
  setDeploymentRoutingScores,
} from '../services/inferenceCatalogueAdmin.service';
import {
  ingestModelRelease,
  ModelReleaseRefused,
  ModelRevisionNotFound,
  recordRevisionGpaiDocumentation,
} from '../services/inferenceModelDocumentation.service';
import { readInferenceOperationalMetrics } from '../services/inferenceMetrics.service';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../utils/error';

const router = Router();

/** Its own budget, per the unique-prefix rule. */
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  prefix: 'rl:inference:admin:',
});

/**
 * Staff for the whole router; the two WRITES additionally require the graded
 * `inference:catalogue:publish` capability (#972 section 12).
 *
 * The split is read-versus-write and not endpoint-by-endpoint taste: `GET
 * /rollout` and `GET /deployments` disclose Oxy's own commercial position to a
 * staff member, which is what `requireStaff` is for, while recording a legal
 * review or approving a route ASSERTS that Oxy may resell somebody else's model.
 * The second is not a thing every staff member should be able to do by virtue of
 * being able to read a dashboard.
 */
router.use(adminLimiter, authMiddleware, requireStaff);

/** Publishing a catalogue route is a graded write — see the note above. */
const requireCataloguePublish = requireStaffCapability('inference:catalogue:publish');

/**
 * The release manifest of the in-flight request, EXACTLY as it arrived.
 *
 * A `WeakMap` keyed on the request, rather than a property on `req`: adding one
 * would mean widening Express's `Request` type for a value that lives for the
 * duration of one handler, and a widened type is a place any other middleware can
 * write to.
 *
 * It has to be captured BEFORE `validate`, which replaces `req.body` with the
 * PARSED value. That distinction is the whole point. A release signature covers
 * the canonical serialization of the manifest, and canonicalization is invariant
 * to whitespace and key order but NOT to a key SET — zod's `.default([])` members
 * alone would add `evaluations` and `knownLimitations` keys the signer never
 * wrote, so a verifier fed the parsed document would compute different bytes and
 * report a valid signature as invalid.
 */
const rawManifests = new WeakMap<Request, string>();

/** Stash the manifest as received. See {@link rawManifests}. */
function captureRawManifest(req: Request, _res: Response, next: NextFunction): void {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'manifest' in body) {
    rawManifests.set(req, JSON.stringify(body.manifest));
  }
  next();
}

/** The staff view of a route — deliberately everything, this being the point. */
const DEPLOYMENT_ADMIN_COLUMNS = {
  id: inferenceDeployments.id,
  modelRevisionId: inferenceDeployments.modelRevisionId,
  providerSlug: inferenceDeployments.providerSlug,
  regions: inferenceDeployments.regions,
  availabilityScope: inferenceDeployments.availabilityScope,
  commercialPermission: inferenceDeployments.commercialPermission,
  permissionState: inferenceDeployments.permissionState,
  permissionStateChangedAt: inferenceDeployments.permissionStateChangedAt,
  permissionStateChangedByUserId: inferenceDeployments.permissionStateChangedByUserId,
  permissionStateNote: inferenceDeployments.permissionStateNote,
  legalReviewStatus: inferenceDeployments.legalReviewStatus,
  legalReviewEvidenceRef: inferenceDeployments.legalReviewEvidenceRef,
  legalReviewedAt: inferenceDeployments.legalReviewedAt,
  legalReviewedByUserId: inferenceDeployments.legalReviewedByUserId,
  status: inferenceDeployments.status,
  dedicatedCapacity: inferenceDeployments.dedicatedCapacity,
  priceVersionId: inferenceDeployments.priceVersionId,
  internalRouteId: inferenceDeployments.internalRouteId,
  routingPriceScore: inferenceDeploymentRoutingScores.priceScore,
  routingPriceSource: inferenceDeploymentRoutingScores.priceSource,
  routingPriceEvidenceRef: inferenceDeploymentRoutingScores.priceEvidenceRef,
  routingPriceVersionId: inferenceDeploymentRoutingScores.priceVersionId,
  routingLatencyScore: inferenceDeploymentRoutingScores.latencyScore,
  routingLatencySource: inferenceDeploymentRoutingScores.latencySource,
  routingLatencyEvidenceRef: inferenceDeploymentRoutingScores.latencyEvidenceRef,
  routingLatencyMeasurementWindowStart:
    inferenceDeploymentRoutingScores.latencyMeasurementWindowStart,
  routingLatencyMeasurementWindowEnd:
    inferenceDeploymentRoutingScores.latencyMeasurementWindowEnd,
  routingLatencyValidUntil: inferenceDeploymentRoutingScores.latencyValidUntil,
  routingThroughputScore: inferenceDeploymentRoutingScores.throughputScore,
  routingThroughputSource: inferenceDeploymentRoutingScores.throughputSource,
  routingThroughputEvidenceRef: inferenceDeploymentRoutingScores.throughputEvidenceRef,
  routingThroughputMeasurementWindowStart:
    inferenceDeploymentRoutingScores.throughputMeasurementWindowStart,
  routingThroughputMeasurementWindowEnd:
    inferenceDeploymentRoutingScores.throughputMeasurementWindowEnd,
  routingThroughputValidUntil: inferenceDeploymentRoutingScores.throughputValidUntil,
  routingBalancedScore: inferenceDeploymentRoutingScores.balancedScore,
  routingBalancedSource: inferenceDeploymentRoutingScores.balancedSource,
  routingBalancedEvidenceRef: inferenceDeploymentRoutingScores.balancedEvidenceRef,
  routingBalancedFormulaRef: inferenceDeploymentRoutingScores.balancedFormulaRef,
  routingBalancedValidUntil: inferenceDeploymentRoutingScores.balancedValidUntil,
  routingScoreReason: inferenceDeploymentRoutingScores.reason,
  routingScoreChangedByUserId: inferenceDeploymentRoutingScores.changedByUserId,
  routingScoreChangedAt: inferenceDeploymentRoutingScores.changedAt,
  upstreamWholesaleCostAmount: inferenceDeployments.upstreamWholesaleCostAmount,
  upstreamWholesaleCostCurrency: inferenceDeployments.upstreamWholesaleCostCurrency,
  upstreamWholesaleCostUnit: inferenceDeployments.upstreamWholesaleCostUnit,
  upstreamWholesaleCostPer: inferenceDeployments.upstreamWholesaleCostPer,
  createdAt: inferenceDeployments.createdAt,
  updatedAt: inferenceDeployments.updatedAt,
} as const;

/** The authenticated staff member's id, or a 401 — never an implicit fallback. */
function staffUserId(req: AuthRequest): string {
  const id = req.user?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new UnauthorizedError('Authentication is required for this operation');
  }
  return id;
}

/**
 * `GET /inference/admin/rollout`
 *
 * What is switched on in THIS deployment (issue #972 workstream 16). The whole
 * point of `config/rolloutFlags.ts` having one readout is that "is charging on
 * in production" is a question with an answer, rather than an ssh session and a
 * grep through a task definition.
 *
 * Staff-only, like everything else on this router: which stage of a commercial
 * rollout a deployment is in is not a customer's business, and the audience
 * report names the applications in a closed beta. It reports the RESOLVED state
 * and the reason for it, never the raw environment value.
 */
router.get(
  '/rollout',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.json({ data: describeRolloutFlags() });
  })
);

/**
 * `GET /inference/admin/spend-anomalies`
 *
 * Every account-hour whose inference spend jumped past a multiple of its own
 * trailing daily median (#972 sections 8 and 12), newest first.
 *
 * A READ, and the only consumer of `inference_spend_anomalies`. The detector
 * blocks nothing — that is argued at length in
 * `services/spendAnomaly.service.ts` — so this endpoint is what turns the signal
 * into something a person can act on. It lives on this router for the same reason
 * `GET /rollout` does: it needs the staff gate and nothing weaker, and a second
 * staff mount is a second thing to keep gated correctly.
 *
 * Not graded by capability: it discloses no credential and changes nothing.
 */
router.get(
  '/spend-anomalies',
  validate({ query: spendAnomalyQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { limit } = spendAnomalyQuery.parse(req.query);
    const rows = await getDb()
      .select()
      .from(inferenceSpendAnomalies)
      .orderBy(desc(inferenceSpendAnomalies.detectedForHour))
      .limit(limit);

    res.json({ data: rows, count: rows.length });
  })
);

/**
 * `GET /inference/admin/token-anomalies`
 *
 * Every account-hour whose TOKEN consumption jumped past a multiple of its own
 * trailing daily median (#972 section 8), newest first.
 *
 * The token half of "spend/token spikes"; `GET /spend-anomalies` beside it is the
 * money half. They are separate endpoints over separate tables because they are
 * separate claims: a token spike with flat spend means a retry loop or a prompt
 * that grew, a spend spike with flat tokens means a switch to an expensive model,
 * and one endpoint returning both would answer neither question.
 *
 * A READ, and the only consumer of `inference_token_anomalies`. The detector blocks
 * nothing — argued at length in `services/tokenAnomaly.service.ts` — so this is
 * what turns the signal into something a person can act on.
 *
 * Not graded by capability: it discloses no credential and changes nothing.
 */
router.get(
  '/token-anomalies',
  validate({ query: tokenAnomalyQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { limit } = tokenAnomalyQuery.parse(req.query);
    const rows = await getDb()
      .select()
      .from(inferenceTokenAnomalies)
      .orderBy(desc(inferenceTokenAnomalies.detectedForHour))
      .limit(limit);

    res.json({ data: rows, count: rows.length });
  })
);

/**
 * `GET /inference/admin/metrics?from=&to=[&accountId=][&applicationId=]`
 *
 * The workstream-16 operational metrics: request rate, error rate, cancellation,
 * total latency, time to first token, fallback, reserve failures, settlement lag
 * and reconciliation drift.
 *
 * ## Not `GET /metrics`, and the difference is the reason it is here
 *
 * `server.ts`'s `GET /metrics` is a PROCESS-LOCAL registry — an in-memory ring
 * buffer keyed by `METHOD /path`, one instance's view, discarded on every deploy.
 * Everything on this route is a QUERY over the durable record, so the answer is
 * identical from any instance and survives a deploy. Overloading the older
 * endpoint would put two different kinds of number under one key and invite a
 * reader to compare them.
 *
 * ## Two of the metrics report a PENDING state rather than a zero
 *
 * `timeToFirstTokenMs` and `fallback` come back as
 * `{ state: 'pending', reason, observedRows, rowsCarryingValue }` while no row
 * carries a value. A `0` there would be indistinguishable from a correctly-zero
 * measurement, and the second reading is the one a dashboard takes. The state is
 * derived from the rows, so it flips to `measured` on its own the moment one
 * arrives.
 *
 * The reason names the MEASURED absence, not a cause — the edge streams both
 * dialects and forwards both figures when a report carries them. `dataPlane` on the
 * payload is what supplies the cause: `absent` means nothing can have streamed, so
 * the pending needs no investigation, while the same pending with `configured`
 * means the data plane is not reporting what it should.
 *
 * Staff-only, like everything on this router: request counts per application are
 * customer data, and a settlement-lag distribution is Oxy's own operational
 * figure. No wholesale cost or price column is read by any query behind it.
 */
router.get(
  '/metrics',
  validate({ query: metricsQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = metricsQuery.parse(req.query);
    const metrics = await readInferenceOperationalMetrics({
      window: { from: query.from, to: query.to },
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.applicationId === undefined ? {} : { applicationId: query.applicationId }),
    });
    res.json({ data: metrics });
  })
);

/**
 * `GET /inference/admin/deployments`
 *
 * Every route in the catalogue, including the ones no customer can see. Ordered
 * newest first, which is the review queue's natural order — a route is looked
 * at because somebody has just proposed it.
 */
router.get(
  '/deployments',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const rows = await getDb()
      .select({
        ...DEPLOYMENT_ADMIN_COLUMNS,
        modelId: inferenceModels.modelId,
        revision: inferenceModelRevisions.revision,
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
      .orderBy(desc(inferenceDeployments.createdAt));

    res.json({ data: rows, count: rows.length });
  })
);

/**
 * `POST /inference/admin/deployments/:deploymentId/legal-review`
 *
 * Records the outcome of a contract/legal review. Separate from approving,
 * because they are two decisions usually taken by two people — and because the
 * database refuses an approval whose review is not itself approved, so folding
 * them together would make one call that can only half-succeed.
 */
router.post(
  '/deployments/:deploymentId/legal-review',
  requireCataloguePublish,
  validate({ params: deploymentParams, body: legalReviewBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = legalReviewBody.parse(req.body);
    try {
      const result = await recordLegalReview({
        deploymentId: req.params.deploymentId,
        status: body.status,
        evidenceRef: body.evidenceRef,
        reviewerUserId: staffUserId(req),
      });
      res.json({ data: result });
    } catch (error) {
      throw translate(error);
    }
  })
);

/**
 * Replace every explicit routing score and its per-dimension provenance for one exact
 * Kaana deployment identity. This is a complete scorecard PUT: omitted keys are
 * invalid, while NULL deliberately withdraws a signal rather than inventing a
 * value. The Kaana id in this path is not an Oxy catalogue row id or provider
 * slug.
 *
 * @response 200 routingScorecardResponse The complete scorecard stored for this exact Kaana deployment.
 */
router.put(
  '/kaana-deployments/:kaanaDeploymentId/routing-scorecard',
  requireCataloguePublish,
  validate({ params: kaanaDeploymentParams, body: routingScoresBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const scores = routingScoresBody.parse(req.body);
    try {
      const result = await setDeploymentRoutingScores({
        deploymentId: req.params.kaanaDeploymentId,
        scorecard: scores,
        staffUserId: staffUserId(req),
      });
      res.json(routingScorecardResponse.parse({ data: result }));
    } catch (error) {
      throw translate(error);
    }
  })
);

/**
 * `POST /inference/admin/deployments/:deploymentId/:action`
 *
 * `approve` | `restrict` | `suspend` | `retire`.
 */
router.post(
  '/deployments/:deploymentId/:action',
  requireCataloguePublish,
  validate({ params: permissionActionParams, body: permissionActionBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const params = permissionActionParams.parse(req.params);
    const body = permissionActionBody.parse(req.body);
    try {
      const result = await applyPermissionAction({
        deploymentId: params.deploymentId,
        action: params.action,
        staffUserId: staffUserId(req),
        note: body.note,
      });
      res.json({ data: result });
    } catch (error) {
      throw translate(error);
    }
  })
);

/**
 * `POST /inference/admin/model-releases`
 *
 * Ingest a signed Alia model release manifest, the capability sheet the manifest
 * cannot carry, and the EU AI Act / GPAI documentation record for the revision it
 * releases (#972 §12).
 *
 * ## Graded on the SAME capability as approving a route, deliberately
 *
 * `inference:catalogue:publish` already means "publishing, restricting or
 * retiring a model route in the inference catalogue", and this writes the model
 * and revision IDENTITIES that a route is later attached to — under `alia/*`,
 * where the namespace itself is a provenance claim. A second capability whose
 * grant list would be exactly the same people would lengthen the list in
 * `users.staff_capabilities` without making any state unreachable, and
 * `STAFF_CAPABILITIES`' own header says a grant list nobody reads is the failure
 * mode.
 *
 * ## Ingesting is not publishing
 *
 * The revision lands with `is_current = false` and no deployment, so nothing here
 * becomes servable or listed. See the service module's header for why that is the
 * containment that makes an unverifiable signature acceptable at this stage.
 */
router.post(
  '/model-releases',
  requireCataloguePublish,
  captureRawManifest,
  validate({ body: modelReleaseIngestionRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = modelReleaseIngestionRequestSchema.parse(req.body);
    const manifestJson = rawManifests.get(req);

    if (manifestJson === undefined) {
      // Unreachable behind `captureRawManifest` + `validate`, which together
      // guarantee a `manifest` member was present. Stated rather than asserted
      // away, because the alternative is storing bytes that are not the ones that
      // arrived — and that is the one failure this whole record exists to avoid.
      throw new BadRequestError('The release manifest could not be read as received');
    }

    try {
      const result = await ingestModelRelease({
        manifest: body.manifest,
        gpaiDocumentation: body.gpaiDocumentation,
        model: body.model,
        manifestJson,
        staffUserId: staffUserId(req),
      });
      res.status(result.outcome === 'ingested' ? 201 : 200).json({ data: result });
    } catch (error) {
      throw translate(error);
    }
  })
);

/**
 * `PUT /inference/admin/revisions/:revisionId/gpai-documentation`
 *
 * Restate the documentation record for a revision that already exists.
 *
 * A PUT and not a PATCH: the Article 53(2) and Article 51(2) conditionals are
 * about the record AS A WHOLE, so a partial update could satisfy them against
 * fields the caller never saw. Replacing means whoever writes it has read all of
 * it.
 *
 * It exists because Article 51(1)(b) lets the Commission designate a model as
 * carrying systemic risk AFTER release, which turns a complete record into an
 * incomplete one through no act of Oxy's — and the alternative, re-releasing
 * identical weights under a new revision, is exactly what the revision
 * immutability trigger is right to refuse.
 */
router.put(
  '/revisions/:revisionId/gpai-documentation',
  requireCataloguePublish,
  validate({ params: revisionParams, body: modelGpaiDocumentationSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const params = revisionParams.parse(req.params);
    const documentation = modelGpaiDocumentationSchema.parse(req.body);
    try {
      const result = await recordRevisionGpaiDocumentation({
        modelRevisionId: params.revisionId,
        documentation,
        staffUserId: staffUserId(req),
      });
      res.json({ data: result });
    } catch (error) {
      throw translate(error);
    }
  })
);

/**
 * Turn the service's own refusals into the HTTP answers they mean.
 *
 * Anything else is re-thrown untouched, so a constraint violation still reaches
 * the global error handler as a 500 rather than being flattened into a 409 that
 * implies somebody's request was at fault.
 *
 * `ModelReleaseRefused` answers 409 rather than 400 for the same reason
 * `DeploymentPermissionRefused` does: the request was well formed, and what
 * refused it is the state of the catalogue — a revision label already taken, a
 * manifest disagreeing with the licence on record, an unreserved publisher
 * namespace.
 */
function translate(error: unknown): unknown {
  if (error instanceof DeploymentNotFoundError) return new NotFoundError(error.message);
  if (error instanceof DeploymentPermissionRefused) return new ConflictError(error.message);
  if (error instanceof ModelReleaseRefused) return new ConflictError(error.message);
  if (error instanceof ModelRevisionNotFound) return new NotFoundError(error.message);
  return error;
}

export default router;
