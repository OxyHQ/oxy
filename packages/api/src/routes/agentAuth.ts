/** Autonomous account entry. Keys stay in the caller; the API sees only proofs. */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agentChallengeRequestSchema, agentVerifyRequestSchema } from '@oxy.so/contracts';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/error';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { requestAgentChallenge, verifyAgentChallenge } from '../services/agentKeyAuth.service';
import { finalizeDeviceLogin } from '../services/deviceLogin.service';
import sessionService from '../services/session.service';
import { buildSessionAuthResponse } from '../controllers/session.controller';

const router = Router();
const ipLimiter = rateLimit({ prefix: 'rl:agent:ip:', windowMs: 60_000, max: 30,
  keyGenerator: (req) => hashedIpKey(req), message: 'Too many attempts' });
const keyLimiter = rateLimit({ prefix: 'rl:agent:key:', windowMs: 60_000, max: 30,
  keyGenerator: (req) => createHash('sha256').update(req.body.publicKey.toLowerCase()).digest('hex'),
  message: 'Too many attempts' });
router.post('/challenge', ipLimiter, validate({ body: agentChallengeRequestSchema }), keyLimiter,
  asyncHandler(async (req, res) => { res.json(await requestAgentChallenge(req.body.publicKey)); }));
router.post('/verify', ipLimiter, validate({ body: agentVerifyRequestSchema }), keyLimiter,
  asyncHandler(async (req, res) => {
    const session = await verifyAgentChallenge(req.body.publicKey, req.body, req);
    const [account] = await getDb().select({ id: users.id, username: users.username, avatar: users.avatar })
      .from(users).where(eq(users.id, session.userId));
    if (!account) throw new ApiError(401, 'Account unavailable', 'INVALID_SESSION');
    const response = buildSessionAuthResponse(session, { _id: account.id,
      username: account.username ?? undefined, avatar: account.avatar ?? undefined });
    if (!response) throw new ApiError(500, 'Unable to format session', 'INTERNAL_ERROR');
    const extras = await finalizeDeviceLogin({ session, userId: session.userId });
    const token = await sessionService.getAccessToken(session.sessionId);
    if (!token) throw new ApiError(401, 'Autonomous credential unavailable', 'INVALID_SESSION');
    res.json({ ...response, ...extras, accessToken: token.accessToken, expiresAt: token.expiresAt.toISOString() });
  }));
export default router;
