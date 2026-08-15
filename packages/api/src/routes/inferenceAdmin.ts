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
 */

import { Router, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/postgres';
import {
  DEPLOYMENT_LEGAL_REVIEW_STATUSES,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
} from '../db/schema';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import {
  applyPermissionAction,
  DEPLOYMENT_PERMISSION_ACTIONS,
  DeploymentNotFoundError,
  DeploymentPermissionRefused,
  recordLegalReview,
} from '../services/inferenceCatalogueAdmin.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ConflictError, NotFoundError, UnauthorizedError } from '../utils/error';

const router = Router();

/** Its own budget, per the unique-prefix rule. */
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  prefix: 'rl:inference:admin:',
});

router.use(adminLimiter, authMiddleware, requireStaff);

const deploymentParams = z.object({ deploymentId: z.string().min(1).max(128) });

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
