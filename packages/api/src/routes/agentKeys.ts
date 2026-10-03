/** Credential governance always rechecks live session, membership and fresh proof. */
import { Router } from 'express';
import { agentKeyOperationSchema, executeAgentKeyOperationSchema, agentKeyListResponseSchema } from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { accountIdRouteParams } from '../schemas/account.schemas';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/error';
import { requestAgentKeyOperation, executeAgentKeyOperation, listAgentKeys } from '../services/agentKeyGovernance.service';
const router = Router();
const limiter = rateLimit({ prefix: 'rl:agent:governance:', windowMs: 60_000, max: 30,
  keyGenerator: (req) => hashedIpKey(req), message: 'Too many attempts' });
/** GET /accounts/:id/agent-keys
 * List public runtime-key metadata for the autonomous account or its current governors.
 */
router.get('/:id/agent-keys', authMiddleware, requireFirstPartyDeviceAccess, limiter,
  validate({ params: accountIdRouteParams }), asyncHandler(async (req: AuthRequest, res) => {
    if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
    res.json(agentKeyListResponseSchema.parse(await listAgentKeys(req.sessionId, req.params.id)));
  }));
/** POST /accounts/:id/agent-keys/challenge
 * Request a single-use, action- and payload-bound credential-governance challenge.
 */
router.post('/:id/agent-keys/challenge' , authMiddleware, requireFirstPartyDeviceAccess, limiter,
  validate({ params: accountIdRouteParams, body: agentKeyOperationSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
    res.json(await requestAgentKeyOperation(req.sessionId, req.params.id, req.body));
  }));
/** POST /accounts/:id/agent-keys/execute
 * Apply enrollment, rotation, revocation or recovery atomically with fresh proof.
 * Current owner/admin governance is rechecked; autonomous rotation proves old and new keys.
 */
router.post('/:id/agent-keys/execute' , authMiddleware, requireFirstPartyDeviceAccess, limiter,
  validate({ params: accountIdRouteParams, body: executeAgentKeyOperationSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
    res.json(await executeAgentKeyOperation(req.sessionId, req.params.id, req.body.operation, req.body.proof));
  }));
export default router;
