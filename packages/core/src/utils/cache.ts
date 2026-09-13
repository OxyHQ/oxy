/**
 * Centralized cache utility with TTL support
 * 
 * This is a production-ready cache implementation used across the codebase
 * for consistent caching behavior and performance optimization.
 */

/**
 * Cache entry with expiration tracking
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * TTL-based cache implementation
 * 
 * Features:
 * - Automatic expiration based on TTL
 * - Manual cleanup of expired entries
 * - Statistics tracking (hits, misses, hit rate)
 * - Type-safe generic interface
 * 
 * @example
 * ```typescript
 * const cache = new TTLCache<string>(5 * 60 * 1000); // 5 minutes
 * 
 * // Set with default TTL
 * cache.set('key', 'value');
 * 
 * // Set with custom TTL
 * cache.set('key', 'value', 10 * 60 * 1000); // 10 minutes
 * 
 * // Get value
 * const value = cache.get('key');
 * 
 * // Get statistics
 * const stats = cache.getStats();
 * ```
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTTL: number;
  private hits = 0;
  private misses = 0;

  /**
   * Create a new TTL cache
   * @param defaultTTL Default TTL in milliseconds (default: 5 minutes)
   */
  constructor(defaultTTL: number = 5 * 60 * 1000) {
    this.defaultTTL = defaultTTL;
  }

  /**
   * Get a value from cache
   * @param key Cache key
   * @returns Cached value or null if not found or expired
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data;
  }

  /**
   * Set a value in cache
   * @param key Cache key
   * @param data Data to cache
   * @param ttl Optional TTL override (uses default if not provided). An
   *   explicit `0` or negative value is honored as "already expired" — the
   *   entry is stored with `expiresAt <= now`, so the next `get`/`has` treats
   *   it as a miss — rather than silently falling back to the default TTL.
   */
  set(key: string, data: T, ttl?: number): void {
    const now = Date.now();
    // Distinguish "no override provided" (undefined → use default) from an
    // explicit `0`/negative (do not cache). `ttl || this.defaultTTL` collapsed
    // both into the default, making `cacheTTL:0` impossible to honor.
    const effectiveTTL = ttl === undefined ? this.defaultTTL : ttl;
    const expiresAt = now + effectiveTTL;
    this.cache.set(key, { data, timestamp: now, expiresAt });
    if (!cleanupInterval && activeCaches.has(this)) updateCleanupInterval();
  }

  /**
   * Delete a specific cache entry
   * @param key Cache key
   * @returns true if entry was deleted, false if not found
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (activeCaches.has(this)) updateCleanupInterval();
    return deleted;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    if (activeCaches.has(this)) updateCleanupInterval();
  }

  /**
   * Check if a key exists and is not expired
   * @param key Cache key
   * @returns true if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get all valid cache keys
   * @returns Array of valid cache keys
   */
  keys(): string[] {
    const now = Date.now();
    const validKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now <= entry.expiresAt) {
        validKeys.push(key);
      } else {
        this.cache.delete(key);
      }
    }

    return validKeys;
  }

  /**
   * Clean up expired entries
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache size (number of entries)
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset statistics (keeps cache entries)
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Create a TTL cache instance (convenience function)
 * 
 * @example
 * ```typescript
 * const cache = createCache<string>(5 * 60 * 1000);
 * ```
 */
export function createCache<T>(ttl: number = 5 * 60 * 1000): TTLCache<T> {
  return new TTLCache<T>(ttl);
}

/**
 * Global cache cleanup interval (runs every minute)
 * This helps prevent memory leaks from expired cache entries
 */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
const activeCaches = new Set<TTLCache<any>>();

/**
 * Register a cache for automatic cleanup
 * @param cache Cache instance to register
 */
export function registerCacheForCleanup(cache: TTLCache<any>): void {
  activeCaches.add(cache);
  updateCleanupInterval();
}

/** Empty registered caches need no timer; importing a client must stay inert. */
function updateCleanupInterval(): void {
  const hasEntries = [...activeCaches].some(cache => cache.size() > 0);
  if (!hasEntries) {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = null;
    return;
  }
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    for (const cache of activeCaches) cache.cleanup();
    updateCleanupInterval();
  }, 60_000);
  cleanupInterval.unref?.();
}

/** Unregister a cache without changing its entries or TTL behavior. */
export function unregisterCacheFromCleanup(cache: TTLCache<any>): void {
  activeCaches.delete(cache);
  updateCleanupInterval();
}

/**
 * Stop all cleanup intervals (useful for testing)
 * This will clear the interval and unregister all caches
 */
export function stopAllCleanupIntervals(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  activeCaches.clear();
}

