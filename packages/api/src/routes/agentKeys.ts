/** Credential governance always rechecks live session, membership and fresh proof. */
import { Router } from 'express';
import { agentKeyOperationSchema, executeAgentKeyOperationSchema } from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { accountIdRouteParams } from '../schemas/account.schemas';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/error';
import { requestAgentKeyOperation, executeAgentKeyOperation } from '../services/agentKeyGovernance.service';
const router = Router();
const limiter = rateLimit({ prefix: 'rl:agent:governance:', windowMs: 60_000, max: 30,
  keyGenerator: (req) => hashedIpKey(req), message: 'Too many attempts' });
router.post('/:id/agent-keys/challenge', authMiddleware, requireFirstPartyDeviceAccess, limiter,
  validate({ params: accountIdRouteParams, body: agentKeyOperationSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
    res.json(await requestAgentKeyOperation(req.sessionId, req.params.id, req.body));
  }));
router.post('/:id/agent-keys/execute', authMiddleware, requireFirstPartyDeviceAccess, limiter,
  validate({ params: accountIdRouteParams, body: executeAgentKeyOperationSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
    res.json(await executeAgentKeyOperation(req.sessionId, req.params.id, req.body.operation, req.body.proof));
  }));
export default router;
