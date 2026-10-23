import { Router, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { profileAccessInputSchema, profileAccessDecisionSchema } from '@oxy.so/contracts';
import type { AuthRequest } from '../middleware/auth';
import {
  requesterAuthMiddleware,
  authenticatedRequesterAccountId,
} from '../middleware/requesterAuth';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { decideProfileAccess } from '../services/profileAccess.service';
import { logger } from '../utils/logger';
const router = Router();
router.use((_req, res, next) => {
  res.locals.apiErrorFormat = 'nested';
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const optionalAuthMiddleware: RequestHandler = (req, res, next) =>
  req.headers.authorization ? requesterAuthMiddleware(req, res, next) : next();
/**
 * Decide whether the original optional bearer may read sensitive profile details.
 * @requestQuery profileAccessInputSchema
 * @response 200 profileAccessDecisionSchema Authoritative profile access decision.
 */
router.get(
  '/profile-access',
  rateLimit({
    prefix: 'rl:safety:profile-access:',
    windowMs: 60000,
    max: 3000,
    errorFormat: 'nested',
    keyGenerator: hashedIpKey,
  }),
  optionalAuthMiddleware,
  (req: AuthRequest, res: Response) => {
    void (async () => {
      const input = profileAccessInputSchema.parse(req.query);
      res.json(
        profileAccessDecisionSchema.parse(
          await decideProfileAccess(
            input.subjectAccountId,
            authenticatedRequesterAccountId(req) ?? null,
          ),
        ),
      );
    })().catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: { code: 'bad_request', message: 'Invalid profile access request' } });
        return;
      }
      logger.error(
        'Profile access policy unavailable',
        error instanceof Error ? error : new Error(String(error)),
      );
      res.status(503).json({
        error: { code: 'service_unavailable', message: 'Profile access could not be determined' },
      });
    });
  },
);
export default router;
