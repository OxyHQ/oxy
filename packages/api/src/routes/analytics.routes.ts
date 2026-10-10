import express from 'express';
import {
  getAnalytics,
  updateAnalytics,
  getContentViewers,
  getFollowerDetails,
} from '../controllers/analytics.controller';
import { checkPremiumAccess } from '../middleware/premiumAccess';

const router = express.Router();

// Add premium check middleware to all analytics routes
router.use(checkPremiumAccess);

router.get('/', getAnalytics);
router.post('/update', updateAnalytics);
router.get('/viewers', getContentViewers);
router.get('/followers', getFollowerDetails);

export default router;
