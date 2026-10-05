import { Router, type Response } from 'express';
import { subjectProductAccessQuerySchema, subjectProductGrantSnapshotSchema } from '@oxy.so/contracts';
import { productAccessResponseSchema, productAccessParamsSchema } from '../schemas/productAccess.schemas';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { parseValidatedRequestValue, validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { UnauthorizedError } from '../utils/error';
import { readAuthorizedSubjectProductAccess, readAuthorizedSubjectProductGrantSnapshot } from '../services/productAccessAuthorization.service';

const router = Router();
const readLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, prefix: 'rl:product:access:read:' });
// The shared user authentication boundary accepts no anonymous/service shortcut.
/**
 * Read the effective subject's rights for the session's application product.
 * Requires an application-bound user:read session, live account:read authority
 * and a usable production credential. Subject must equal the current session
 * subject. Missing/inconsistent configuration fails closed. No legacy balances
 * are interpreted; reads explicitly registered live production sources only.
 * @response 200 productAccessResponseSchema Access-only result; Cache-Control no-store.
 * @response 400 Error Invalid path parameters.
 * @response 401 Error Current session authority unavailable.
 * @response 403 Error Required credential, scope or account permission unavailable.
 * @response 404 Error Subject or product audience unavailable.
 * @response 503 Error Product configuration missing or inconsistent.
 */
router.get('/:productId/access/:subjectAccountId', authMiddleware, readLimiter, validate({ params: productAccessParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.oxyToken) throw new UnauthorizedError();
    const query = parseValidatedRequestValue(subjectProductAccessQuerySchema, { schemaVersion: 1,
      productId: req.params.productId, subjectAccountId: req.params.subjectAccountId });
    const data = await readAuthorizedSubjectProductAccess(req.oxyToken, query);
    res.set('Cache-Control', 'no-store');
    res.json(productAccessResponseSchema.parse({ data }));
  }));
router.get('/:productId/access/:subjectAccountId/grants', authMiddleware, readLimiter, validate({ params: productAccessParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.oxyToken) throw new UnauthorizedError();
    const query = parseValidatedRequestValue(subjectProductAccessQuerySchema, { schemaVersion: 1,
      productId: req.params.productId, subjectAccountId: req.params.subjectAccountId });
    const data = await readAuthorizedSubjectProductGrantSnapshot(req.oxyToken, query);
    res.set('Cache-Control', 'no-store');
    res.json({ data: subjectProductGrantSnapshotSchema.parse(data) });
  }));
export default router;
