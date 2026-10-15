import { Router, type Response } from 'express';
import { z } from 'zod';
import { profileAccessInputSchema, profileAccessDecisionSchema } from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
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
router.get(
  '/profile-access',
  rateLimit({
    prefix: 'rl:safety:profile-access:',
    windowMs: 60000,
    max: 3000,
    errorFormat: 'nested',
    keyGenerator: hashedIpKey,
  }),
  (req, res, next) => (req.headers.authorization ? authMiddleware(req, res, next) : next()),
  (req: AuthRequest, res: Response) => {
    void (async () => {
      const input = profileAccessInputSchema.parse(req.query);
      res.json(
        profileAccessDecisionSchema.parse(
          await decideProfileAccess(input.subjectAccountId, req.user?._id?.toString() ?? null),
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
