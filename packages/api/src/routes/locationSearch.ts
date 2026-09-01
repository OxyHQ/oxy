import express from 'express';
import locationSearchController from '../controllers/locationSearch.controller';
import { authMiddleware } from '../middleware/auth';
import { requireStaff } from '../middleware/requireStaff';

const router = express.Router();

// Search for locations
router.get('/search', authMiddleware, locationSearchController.searchLocations);

// Get location details by coordinates
router.get('/details', authMiddleware, locationSearchController.getLocationDetails);

// Cache management routes
router.get('/cache/stats', authMiddleware, requireStaff, locationSearchController.getCacheStats);
router.delete('/cache', authMiddleware, requireStaff, locationSearchController.clearCache);

// Database query routes
router.get('/near', authMiddleware, locationSearchController.findLocationsNear);
router.get('/db-search', authMiddleware, locationSearchController.searchLocationsInDB);
router.get('/stats', authMiddleware, locationSearchController.getLocationStats);

// Performance monitoring routes
router.get('/performance', authMiddleware, locationSearchController.getPerformanceStats);

export default router; 