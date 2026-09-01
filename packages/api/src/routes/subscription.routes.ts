import express from 'express';
import { getSubscription, cancelSubscription } from '../controllers/subscription.controller';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { subscriptionUserIdParams } from '../schemas/subscription.schemas';

const router = express.Router();

// All subscription routes require authentication
router.use(authMiddleware);

/**
 * GET /api/subscription/:userId
 * Get user subscription
 */
router.get('/:userId', validate({ params: subscriptionUserIdParams }), asyncHandler(async (req, res) => {
  await getSubscription(req as AuthRequest, res);
}));

/**
 * DELETE /api/subscription/:userId
 * Cancel user subscription
 */
router.delete('/:userId', validate({ params: subscriptionUserIdParams }), asyncHandler(async (req, res) => {
  await cancelSubscription(req as AuthRequest, res);
}));

export default router;

