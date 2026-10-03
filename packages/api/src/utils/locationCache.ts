import { isRollbackAuthOnly } from '../config/runtimeMode';
import { logger } from './logger';

interface CachedLocation {
  query: string;
  results: any[];
  timestamp: number;
  ttl: number;
}

interface LocationCacheConfig {
  maxSize: number;
  defaultTTL: number; // in milliseconds
  cleanupInterval: number; // in milliseconds
}

class LocationCache {
  private cache: Map<string, CachedLocation> = new Map();
  private config: LocationCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<LocationCacheConfig> = {}) {
    this.config = {
      maxSize: 1000,
      defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
      cleanupInterval: 60 * 60 * 1000, // 1 hour
      ...config
    };

    this.startCleanupTimer();
  }

  /**
   * Generate cache key from search parameters
   */
  private generateKey(query: string, limit: number, countrycodes?: string): string {
    const normalizedQuery = query.toLowerCase().trim();
    const countryCodeStr = countrycodes ? `:${countrycodes.toLowerCase()}` : '';
    return `${normalizedQuery}:${limit}${countryCodeStr}`;
  }

  /**
   * Get cached results for a search query
   */
  get(query: string, limit: number, countrycodes?: string): any[] | null {
    const key = this.generateKey(query, limit, countrycodes);
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check if cache entry has expired
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.cache.delete(key);
      return null;
    }

    logger.debug(`Cache hit for query: ${query}`);
    return cached.results;
  }

  /**
   * Store search results in cache
   */
  set(query: string, limit: number, results: any[], countrycodes?: string, ttl?: number): void {
    const key = this.generateKey(query, limit, countrycodes);
    
    // Remove oldest entries if cache is full
    if (this.cache.size >= this.config.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      query,
      results,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL
    });

    logger.debug(`Cached results for query: ${query} (${results.length} results)`);
  }

  /**
   * Remove the oldest cache entry
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug(`Evicted oldest cache entry: ${oldestKey}`);
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > value.ttl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  /**
   * Start the cleanup timer
   */
  private startCleanupTimer(): void {
    if (isRollbackAuthOnly) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the cleanup timer
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    logger.info('Location cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
    totalHits: number;
    totalMisses: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hitRate: 0, // Would need to track hits/misses
      totalHits: 0,
      totalMisses: 0
    };
  }
}

// Export singleton instance
export const locationCache = new LocationCache();

export default locationCache; 