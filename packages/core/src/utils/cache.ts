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

  private maxEntries: number;
  /** Registered for the shared expiry sweep (see {@link registerCacheForCleanup}). */
  private swept = false;
  /** The sweep generation this cache registered in; {@link stopAllCleanupIntervals} ends it. */
  private sweptGeneration = -1;

  /**
   * Create a new TTL cache
   * @param defaultTTL Default TTL in milliseconds (default: 5 minutes)
   * @param maxEntries Bound on live entries; the least recently used is evicted
   *   past it (default: 1000)
   */
  constructor(defaultTTL: number = 5 * 60 * 1000, maxEntries = 1000) {
    this.defaultTTL = defaultTTL;
    this.maxEntries = maxEntries;
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
    if (now >= entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      this.syncSweep();
      return null;
    }

    // Re-insert so Map order is recency order and eviction drops the LRU.
    this.cache.delete(key);
    this.cache.set(key, entry);
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
    this.cache.delete(key);
    this.cache.set(key, { data, timestamp: now, expiresAt });
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.syncSweep();
  }

  /**
   * Delete a specific cache entry
   * @param key Cache key
   * @returns true if entry was deleted, false if not found
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) this.syncSweep();
    return deleted;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.syncSweep();
  }

  /**
   * Delete every entry whose key matches, in ONE pass.
   * @returns Number of entries deleted
   */
  deleteWhere(match: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (match(key)) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.syncSweep();
    return removed;
  }

  /**
   * Check if a key exists and is not expired
   * @param key Cache key
   * @returns true if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      this.syncSweep();
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
      if (now < entry.expiresAt) {
        validKeys.push(key);
      } else {
        this.cache.delete(key);
      }
    }
    this.syncSweep();

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
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.syncSweep();

    return removed;
  }

  /**
   * Start or stop being swept: a registered cache is held by the shared sweep
   * ONLY while it has entries to expire. An empty cache is referenced by
   * nothing global, so a client nobody disposed is collected with its cache.
   */
  setSwept(swept: boolean): void {
    this.swept = swept;
    this.sweptGeneration = sweepGeneration;
    this.syncSweep();
  }

  private syncSweep(): void {
    if (this.swept && this.sweptGeneration === sweepGeneration && this.cache.size > 0) {
      sweptCaches.add(this);
    } else {
      sweptCaches.delete(this);
    }
    updateCleanupInterval();
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
 * The shared expiry sweep: one unref'd interval, running only while some
 * registered cache holds entries.
 *
 * `sweptCaches` holds exactly the registered caches that are NON-EMPTY. A
 * cache joins when it gains its first entry and leaves when it is emptied — by
 * the sweep itself once its entries expire — so the module never pins a cache
 * that has nothing to expire. That is what keeps a short-lived client that was
 * never disposed (one per request, say) collectable: the most it can be held
 * for is its entries' TTL.
 */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
const sweptCaches = new Set<TTLCache<unknown>>();
/** Bumped by {@link stopAllCleanupIntervals}, which ends every registration. */
let sweepGeneration = 0;

/**
 * Register a cache for automatic cleanup
 * @param cache Cache instance to register
 */
export function registerCacheForCleanup(cache: TTLCache<unknown>): void {
  cache.setSwept(true);
}

/** Empty registered caches need no timer; importing a client must stay inert. */
function updateCleanupInterval(): void {
  if (sweptCaches.size === 0) {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = null;
    return;
  }
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    // `cleanup()` removes an emptied cache from the set as it goes.
    for (const cache of [...sweptCaches]) cache.cleanup();
  }, 60_000);
  cleanupInterval.unref?.();
}

/** Unregister a cache without changing its entries or TTL behavior. */
export function unregisterCacheFromCleanup(cache: TTLCache<unknown>): void {
  cache.setSwept(false);
}

/**
 * Stop all cleanup intervals (useful for testing)
 * This will clear the interval and unregister all caches
 *
 * @internal Test-only; not part of the package's public surface.
 */
export function stopAllCleanupIntervals(): void {
  sweepGeneration += 1;
  sweptCaches.clear();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/** How many caches the shared sweep currently holds (tests). @internal */
export function sweptCacheCount(): number {
  return sweptCaches.size;
}
