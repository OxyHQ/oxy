import { hasServiceAuthority } from '../utils/serviceAuthority';
import { resolveLiveAgencyServicePrincipal } from '../services/agencyServicePrincipal.service';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  organizationSchema,
  organizationListSchema,
  organizationBatchSchema,
  organizationImportBatchResultSchema,
  organizationExternalSchema,
  organizationExternalResolutionSchema,
  organizationClaimSchema,
  organizationClaimDetailSchema,
  organizationClaimListSchema,
  organizationCurationResultSchema,
  organizationErrorSchema,
  createOrganizationSchema,
  organizationBatchInputSchema,
  organizationClaimInputSchema,
  organizationClaimReviewSchema,
  organizationExternalInputSchema,
  organizationMergeSchema,
  organizationSearchSchema,
  organizationClaimListQuerySchema,
  organizationImportBatchSchema,
  organizationCurationSchema,
  updateOrganizationSchema,
  type OrganizationErrorCode,
} from '@oxy.so/contracts';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type ServiceAuthRequest,
  type AuthRequest,
} from '../middleware/auth';
import { resolveOperatorId } from '../middleware/operator';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { getDb } from '../config/postgres';
import { users } from '../db/schema';
import { accountService } from '../services/account.service';
import * as directory from '../services/organization-directory.service';
import { logger } from '../utils/logger';

const router = Router();
function error(res: Response, status: number, code: OrganizationErrorCode, message: string) {
  res.status(status).json({ error: { code, message } });
}
function handler(fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return (req: AuthRequest, res: Response, _next: NextFunction) => {
    void fn(req, res).catch((err: unknown) => {
      if (err instanceof z.ZodError) {
        const malformed = err.issues.some(
          (issue) => issue.code === 'invalid_type' || issue.code === 'unrecognized_keys',
        );
        error(
          res,
          malformed ? 400 : 422,
          malformed ? 'bad_request' : 'validation_failed',
          'Check the organization request fields',
        );
      } else if (err instanceof directory.OrganizationDirectoryError)
        error(res, err.status, err.code, err.message);
      else {
        logger.error(
          'Organization directory request failed',
          err instanceof Error ? err : new Error(String(err)),
        );
        error(
          res,
          503,
          'service_unavailable',
          'The organization directory is temporarily unavailable',
        );
      }
    });
  };
}
router.use((_req, res, next) => {
  res.locals.apiErrorFormat = 'nested';
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const readLimit = rateLimit({
  prefix: 'rl:organizations:read:',
  windowMs: 60000,
  max: 3000,
  errorFormat: 'nested',
  message: 'Too many organization requests',
  keyGenerator: (req: Request) => hashedIpKey(req),
});
const writeLimit = rateLimit({
  prefix: 'rl:organizations:write:',
  windowMs: 60000,
  max: 30,
  errorFormat: 'nested',
  message: 'Too many organization changes',
  keyGenerator: (req: Request) => (req as AuthRequest).user?._id?.toString() ?? hashedIpKey(req),
});
/**
 * Search the public canonical organization directory.
 * @response 200 organizationListSchema Success.
 * @requestQuery organizationSearchSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/',
  readLimit,
  handler(async (req, res) =>
    res.json(await directory.searchOrganizations(organizationSearchSchema.parse(req.query))),
  ),
);
/**
 * Resolve up to 100 public organization account IDs.
 * @response 200 organizationBatchSchema Success.
 * @requestBody organizationBatchInputSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/batch',
  readLimit,
  handler(async (req, res) =>
    res.json(await directory.batchOrganizations(organizationBatchInputSchema.parse(req.body).ids)),
  ),
);

async function personalUser(req: AuthRequest): Promise<string> {
  const userId = req.user?._id?.toString();
  if (!userId || req.user?.kind !== 'personal')
    throw new directory.OrganizationDirectoryError(
      403,
      'forbidden',
      'A personal user session is required',
    );
  return userId;
}
/** Staff privilege is re-read for each sensitive decision, never trusted from a stale session cache. */
function staffDecision(req: AuthRequest, res: Response, next: NextFunction) {
  void (async () => {
    const userId = await personalUser(req);
    const [user] = await getDb()
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, userId));
    if (!user?.isStaff) {
      error(res, 403, 'forbidden', 'Platform staff authority is required');
      return;
    }
    res.locals.organizationReviewerId = userId;
    next();
  })().catch((err: unknown) => {
    if (err instanceof directory.OrganizationDirectoryError)
      error(res, err.status, err.code, err.message);
    else error(res, 503, 'service_unavailable', 'Staff authority could not be verified');
  });
}
const ingestionLimit = rateLimit({
  prefix: 'rl:organizations:import:',
  windowMs: 60000,
  max: 120,
  errorFormat: 'nested',
  message: 'Too many organization import batches',
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? hashedIpKey(req),
});
/**
 * Import neutral entries using a scoped consumer service grant.
 * @response 200 organizationImportBatchResultSchema Success.
 * @requestBody organizationImportBatchSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/external/batch',
  serviceAuthMiddleware,
  ingestionLimit,
  handler(async (req, res) => {
    const input = organizationImportBatchSchema.parse(req.body);
    const token = (req as ServiceAuthRequest).serviceApp;
    const principal = token ? await resolveLiveAgencyServicePrincipal(token) : null;
    if (
      !hasServiceAuthority(principal, 'organizations:import') ||
      !principal ||
      !principal.capabilities.includes(`organizations:import:${input.namespace}`)
    )
      throw new directory.OrganizationDirectoryError(
        403,
        'forbidden',
        'The application does not have an organization import grant for this namespace',
      );
    res.json(await directory.importOrganizationBatch(input, principal));
  }),
);
/**
 * Staff-reviewed idempotent external identity mapping.
 * @response 200 organizationExternalSchema Success.
 * @requestBody organizationExternalInputSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/external',
  authMiddleware,
  staffDecision,
  writeLimit,
  handler(async (req, res) => {
    res.json(
      await directory.importOrganizationExternal(
        organizationExternalInputSchema.parse(req.body),
        await personalUser(req),
      ),
    );
  }),
);
/**
 * Resolve a reviewed external mapping with platform staff authority.
 * @response 200 organizationExternalResolutionSchema Success.
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/external/:namespace/:externalId',
  authMiddleware,
  staffDecision,
  handler(async (req, res) => {
    const namespace = organizationExternalInputSchema.shape.namespace.parse(req.params.namespace);
    const externalId = organizationExternalInputSchema.shape.externalId.parse(
      req.params.externalId,
    );
    res.json(await directory.resolveOrganizationExternal(namespace, externalId));
  }),
);
/**
 * List the caller’s private claim requests.
 * @response 200 organizationClaimListSchema Success.
 * @requestQuery organizationClaimListQuerySchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/claims/mine',
  authMiddleware,
  readLimit,
  handler(async (req, res) =>
    res.json(
      await directory.listOrganizationClaims(
        await personalUser(req),
        organizationClaimListQuerySchema.parse(req.query),
      ),
    ),
  ),
);
/**
 * Read one claim owned by the caller.
 * @response 200 organizationClaimDetailSchema Success.
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/claims/mine/:claimId',
  authMiddleware,
  readLimit,
  handler(async (req, res) =>
    res.json(
      await directory.getOrganizationClaim(String(req.params.claimId), await personalUser(req)),
    ),
  ),
);
/**
 * Read the private staff claim review queue.
 * @response 200 organizationClaimListSchema Success.
 * @requestQuery organizationClaimListQuerySchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/claims/review',
  authMiddleware,
  staffDecision,
  readLimit,
  handler(async (req, res) =>
    res.json(
      await directory.listOrganizationClaims(
        null,
        organizationClaimListQuerySchema.parse(req.query),
      ),
    ),
  ),
);
/**
 * Read claim evidence with current staff authority.
 * @response 200 organizationClaimDetailSchema Success.
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/claims/review/:claimId',
  authMiddleware,
  staffDecision,
  readLimit,
  handler(async (req, res) =>
    res.json(await directory.getOrganizationClaim(String(req.params.claimId), null)),
  ),
);
/**
 * Independently review a claim with current staff authority.
 * @response 200 organizationClaimSchema Success.
 * @requestBody organizationClaimReviewSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/claims/:claimId/review',
  authMiddleware,
  staffDecision,
  writeLimit,
  handler(async (req, res) => {
    const input = organizationClaimReviewSchema.parse(req.body);
    res.json(
      await directory.reviewOrganizationClaim(
        String(req.params.claimId),
        await personalUser(req),
        input.decision,
        input.evidenceReference,
      ),
    );
  }),
);
/**
 * Staff-curate neutral facts or moderate directory visibility.
 * @response 200 organizationCurationResultSchema Success.
 * @requestBody organizationCurationSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/:accountId/curation',
  authMiddleware,
  staffDecision,
  writeLimit,
  handler(async (req, res) => {
    res.json(
      await directory.curateOrganization(
        String(req.params.accountId),
        organizationCurationSchema.parse(req.body),
        await personalUser(req),
      ),
    );
  }),
);
/**
 * Staff-merge an unclaimed identity without merging account authority.
 * @response 200 organizationSchema Success.
 * @requestBody organizationMergeSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/:accountId/merge',
  authMiddleware,
  staffDecision,
  writeLimit,
  handler(async (req, res) => {
    const input = organizationMergeSchema.parse(req.body);
    res.json(
      await directory.mergeOrganizations(
        String(req.params.accountId),
        input.targetAccountId,
        await personalUser(req),
        input.evidenceReference,
      ),
    );
  }),
);
/**
 * Create a neutral unclaimed organization without management authority.
 * @response 201 organizationSchema Success.
 * @requestBody createOrganizationSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/',
  authMiddleware,
  writeLimit,
  handler(async (req, res) => {
    await personalUser(req);
    res
      .status(201)
      .json(await directory.createNeutralOrganization(createOrganizationSchema.parse(req.body)));
  }),
);
/**
 * Read a public organization, resolving canonical redirects.
 * @response 200 organizationSchema Success.
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.get(
  '/:accountId',
  readLimit,
  handler(async (req, res) =>
    res.json(await directory.getOrganization(String(req.params.accountId))),
  ),
);
/**
 * Update facts using organization management authority.
 * @response 200 organizationSchema Success.
 * @requestBody updateOrganizationSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.patch(
  '/:accountId',
  authMiddleware,
  writeLimit,
  handler(async (req, res) => {
    const accountId = String(req.params.accountId);
    const access = await accountService.resolveEffectiveAccess(
      await resolveOperatorId(req),
      accountId,
    );
    if (!access?.permissions.includes('account:update')) {
      error(res, 403, 'forbidden', 'Organization management permission is required');
      return;
    }
    res.json(
      await directory.updateOrganization(accountId, updateOrganizationSchema.parse(req.body)),
    );
  }),
);
/**
 * Submit private ownership evidence without changing permissions.
 * @response 201 organizationClaimSchema Success.
 * @requestBody organizationClaimInputSchema
 * @response 400 organizationErrorSchema Request refused.
 * @response 401 organizationErrorSchema Request refused.
 * @response 403 organizationErrorSchema Request refused.
 * @response 404 organizationErrorSchema Request refused.
 * @response 409 organizationErrorSchema Request refused.
 * @response 422 organizationErrorSchema Request refused.
 * @response 429 organizationErrorSchema Request refused.
 * @response 503 organizationErrorSchema Request refused.
 */
router.post(
  '/:accountId/claims',
  authMiddleware,
  writeLimit,
  handler(async (req, res) => {
    const input = organizationClaimInputSchema.parse(req.body);
    res
      .status(201)
      .json(
        await directory.submitOrganizationClaim(
          String(req.params.accountId),
          await personalUser(req),
          input.evidenceReference,
        ),
      );
  }),
);
export default router;
