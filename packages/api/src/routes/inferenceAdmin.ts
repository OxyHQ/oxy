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

import { Router, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/postgres';
import { describeRolloutFlags } from '../config/rolloutFlags';
import {
  DEPLOYMENT_LEGAL_REVIEW_STATUSES,
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
  applyPermissionAction,
  DEPLOYMENT_PERMISSION_ACTIONS,
  DeploymentNotFoundError,
  DeploymentPermissionRefused,
  recordLegalReview,
} from '../services/inferenceCatalogueAdmin.service';
import { readInferenceOperationalMetrics } from '../services/inferenceMetrics.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ConflictError, NotFoundError, UnauthorizedError } from '../utils/error';

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

const deploymentParams = z.object({ deploymentId: z.string().min(1).max(128) });

/**
 * The widest window a metrics read may ask for.
 *
 * Ninety days is `inference_usage_events`' own retention, so a longer window
 * cannot produce a longer latency series — it would only widen the scan while
 * returning the same samples. Bounding it here makes that a refusal instead of a
 * quietly truncated answer.
 */
const METRICS_MAX_WINDOW_DAYS = 90;

/**
 * A UTC calendar day that EXISTS, the unit both the rollup and the window are
 * keyed in.
 *
 * The shape check alone is not enough. `Date.parse` accepts `2026-02-31` and
 * rolls it into March, so the ROUND TRIP is what rejects a day that does not
 * exist — the same check `config/rolloutFlags.ts` makes of a charging
 * authorization, and for the same reason. Without it a lexically valid impossible
 * date reaches Postgres as `'2026-02-31'::date`, which refuses it and turns the
 * caller's malformed query into a 500.
 */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD UTC day')
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'expected a UTC day that exists');

/** Midnight UTC on a day already validated by {@link isoDay}. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

const metricsQuery = z
  .object({
    from: isoDay,
    to: isoDay,
    accountId: z.string().min(1).max(128).optional(),
    applicationId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (value) =>
      (dayStart(value.to) - dayStart(value.from)) / (24 * 60 * 60 * 1000) <
      METRICS_MAX_WINDOW_DAYS,
    { message: `the window may span at most ${METRICS_MAX_WINDOW_DAYS} days`, path: ['to'] }
  );

/**
 * The action is a PATH segment from a closed set, not a body field.
 *
 * `POST /deployments/:id/approve` cannot be turned into a different action by a
 * malformed body, and an unknown verb 404s at the router before any handler
 * runs. A `{ action }` field would put the decision in mass-assignable data.
 */
const permissionActionParams = deploymentParams.extend({
  action: z.enum(DEPLOYMENT_PERMISSION_ACTIONS),
});

const permissionActionBody = z.object({ note: z.string().max(500).optional() }).strict();

/**
 * The spend-anomaly page size.
 *
 * A ceiling rather than an offset-paginated read: the question this answers is
 * "what fired recently", and 200 rows of it is an operator's screen. Anything
 * larger is a report, which belongs on the reporting surface with a window.
 *
 * `z.coerce.number()`, which is IDEMPOTENT and has to be: `middleware/validate`
 * writes its parsed output back onto `req.query` and the handler parses again, so
 * this schema is fed a number on the second pass. Coercing a number is the
 * identity, so both passes agree — where a transform that only accepted the string
 * form would raise `invalid_type` outside any validation boundary and answer 500.
 * That is not hypothetical; `GET /billing/cost-centers` carried exactly that
 * defect on every request.
 */
const spendAnomalyQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();

const legalReviewBody = z
  .object({
    status: z.enum(DEPLOYMENT_LEGAL_REVIEW_STATUSES),
    /**
     * A reference into the contract register. Bounded and trimmed; the schema
     * cannot tell a real matter reference from a plausible one, so the database
     * additionally refuses an approval whose reference is blank after trimming.
     */
    evidenceRef: z.string().min(1).max(200).optional(),
  })
  .strict();

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
 * Turn the service's own refusals into the HTTP answers they mean.
 *
 * Anything else is re-thrown untouched, so a constraint violation still reaches
 * the global error handler as a 500 rather than being flattened into a 409 that
 * implies somebody's request was at fault.
 */
function translate(error: unknown): unknown {
  if (error instanceof DeploymentNotFoundError) return new NotFoundError(error.message);
  if (error instanceof DeploymentPermissionRefused) return new ConflictError(error.message);
  return error;
}

export default router;
