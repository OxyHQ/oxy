import type { Request, Response } from 'express';
import { logger } from '../utils/logger';
import locationService from '../services/locationService';
import locationQueryService from '../services/locationQueryService';
import performanceMonitor from '../utils/performanceMonitor';

export class LocationSearchController {
  /**
   * Search for locations using optimized service with caching
   */
  async searchLocations(req: Request, res: Response) {
    try {
      const { query, limit = 5, countrycodes, useCache = 'true' } = req.query;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({
          message: 'Query parameter is required',
        });
      }

      if (query.length < 3) {
        return res.status(400).json({
          message: 'Query must be at least 3 characters long',
        });
      }

      const limitNum = Number.parseInt(limit as string) || 5;
      const useCacheBool = useCache === 'true';

      logger.info(
        `Searching locations for query: ${query} (limit: ${limitNum}, cache: ${useCacheBool})`,
      );

      const results = await locationService.searchLocations(query, {
        limit: limitNum,
        countrycodes: countrycodes as string,
        useCache: useCacheBool,
      });

      res.json({
        success: true,
        results,
        query,
        total: results.length,
        cached: useCacheBool,
      });
    } catch (error) {
      logger.error('Error searching locations:', error);

      if (error instanceof Error) {
        if (error.message.includes('Rate limit')) {
          return res.status(429).json({
            message: error.message,
          });
        }
        if (error.message.includes('timeout')) {
          return res.status(408).json({
            message: error.message,
          });
        }
      }

      res.status(500).json({
        message: 'Error searching locations',
      });
    }
  }

  /**
   * Get detailed information about a specific location by coordinates
   */
  async getLocationDetails(req: Request, res: Response) {
    try {
      const { lat, lon, useCache = 'true' } = req.query;

      if (!lat || !lon) {
        return res.status(400).json({
          message: 'Latitude and longitude parameters are required',
        });
      }

      const latitude = Number.parseFloat(lat as string);
      const longitude = Number.parseFloat(lon as string);

      if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({
          message: 'Invalid latitude or longitude values',
        });
      }

      if (latitude < -90 || latitude > 90) {
        return res.status(400).json({
          message: 'Latitude must be between -90 and 90',
        });
      }

      if (longitude < -180 || longitude > 180) {
        return res.status(400).json({
          message: 'Longitude must be between -180 and 180',
        });
      }

      const useCacheBool = useCache === 'true';

      logger.info(
        `Getting location details for coordinates: ${lat}, ${lon} (cache: ${useCacheBool})`,
      );

      const result = await locationService.getLocationDetails(latitude, longitude, {
        useCache: useCacheBool,
      });

      res.json({
        success: true,
        result,
        cached: useCacheBool,
      });
    } catch (error) {
      logger.error('Error getting location details:', error);

      if (error instanceof Error) {
        if (error.message.includes('Rate limit')) {
          return res.status(429).json({
            message: error.message,
          });
        }
      }

      res.status(500).json({
        message: 'Error getting location details',
      });
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(req: Request, res: Response) {
    try {
      const stats = locationService.getCacheStats();
      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      logger.error('Error getting cache stats:', error);
      res.status(500).json({
        message: 'Error getting cache statistics',
      });
    }
  }

  /**
   * Clear cache
   */
  async clearCache(req: Request, res: Response) {
    try {
      locationService.clearCache();
      res.json({
        success: true,
        message: 'Cache cleared successfully',
      });
    } catch (error) {
      logger.error('Error clearing cache:', error);
      res.status(500).json({
        message: 'Error clearing cache',
      });
    }
  }

  /**
   * Find locations near a point using geospatial queries
   */
  async findLocationsNear(req: Request, res: Response) {
    try {
      const { lat, lon, maxDistance = 10000, limit = 10, skip = 0 } = req.query;

      if (!lat || !lon) {
        return res.status(400).json({
          message: 'Latitude and longitude parameters are required',
        });
      }

      const latitude = Number.parseFloat(lat as string);
      const longitude = Number.parseFloat(lon as string);
      const maxDistanceNum = Number.parseFloat(maxDistance as string);
      const limitNum = Number.parseInt(limit as string);
      const skipNum = Number.parseInt(skip as string);

      const result = await locationQueryService.findLocationsNear(
        latitude,
        longitude,
        maxDistanceNum,
        { limit: limitNum, skip: skipNum },
      );

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Error finding locations near point:', error);
      res.status(500).json({
        message: 'Error finding nearby locations',
      });
    }
  }

  /**
   * Search locations in database by text
   */
  async searchLocationsInDB(req: Request, res: Response) {
    try {
      const { query, limit = 10, skip = 0, type, country, city } = req.query;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({
          message: 'Query parameter is required',
        });
      }

      const limitNum = Number.parseInt(limit as string);
      const skipNum = Number.parseInt(skip as string);

      const result = await locationQueryService.searchLocationsByText(query, {
        limit: limitNum,
        skip: skipNum,
        type: type as string,
        country: country as string,
        city: city as string,
      });

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Error searching locations in database:', error);
      res.status(500).json({
        message: 'Error searching locations',
      });
    }
  }

  /**
   * Get location statistics
   */
  async getLocationStats(req: Request, res: Response) {
    try {
      const stats = await locationQueryService.getLocationStats();
      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      logger.error('Error getting location stats:', error);
      res.status(500).json({
        message: 'Error getting location statistics',
      });
    }
  }

  /**
   * Get performance statistics
   */
  async getPerformanceStats(req: Request, res: Response) {
    try {
      const stats = performanceMonitor.getStats();
      const summary = performanceMonitor.getSummary();
      const slowOperations = performanceMonitor.getSlowOperations();

      res.json({
        success: true,
        stats,
        summary,
        slowOperations,
      });
    } catch (error) {
      logger.error('Error getting performance stats:', error);
      res.status(500).json({
        message: 'Error getting performance statistics',
      });
    }
  }
}

export default new LocationSearchController();
