import type { Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import {
  isPremiumSubscriptionPlan,
  resolveUserSubscriptionPlan,
} from '../utils/subscriptionPlan';
import type { AuthRequest } from './auth';

export const checkPremiumAccess = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (!user?._id) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const plan = await resolveUserSubscriptionPlan(user._id.toString());
    if (!isPremiumSubscriptionPlan(plan)) {
      return res.status(403).json({
        message: 'Analytics access denied',
        error: 'PREMIUM_REQUIRED',
        details: 'Analytics features require a premium subscription',
      });
    }

    if (!user.privacySettings?.analyticsSharing) {
      return res.status(403).json({
        message: 'Analytics access denied',
        error: 'ANALYTICS_OPT_OUT',
        details: 'Analytics sharing is disabled in your privacy settings',
      });
    }

    next();
  } catch (error) {
    logger.error('Error checking premium access:', error);
    res.status(500).json({
      message: 'Error checking premium access',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
