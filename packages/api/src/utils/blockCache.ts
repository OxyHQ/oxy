interface CachedBlock {
  isBlocked: boolean;
  timestamp: number;
  ttl: number;
}

interface BlockCacheConfig {
  maxSize: number;
  defaultTTL: number; // in milliseconds
  cleanupInterval: number; // in milliseconds
}

class BlockCache {
  private cache: Map<string, CachedBlock> = new Map();
  private config: BlockCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<BlockCacheConfig> = {}) {
    this.config = {
      maxSize: 100000,
      defaultTTL: 60 * 1000, // 1 minute
      cleanupInterval: 60 * 1000, // 1 minute
      ...config,
    };

    this.startCleanupTimer();
  }

  private generateKey(ownerId: string, viewerId: string): string {
    return `${ownerId}:${viewerId}`;
  }

  get(ownerId: string, viewerId: string): boolean | null {
    if (!ownerId || !viewerId) return null;

    const key = this.generateKey(ownerId, viewerId);
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    const now = Date.now();
    if (now - cached.timestamp > cached.ttl) {
      this.cache.delete(key);
      return null;
    }

    return cached.isBlocked;
  }

  set(ownerId: string, viewerId: string, isBlocked: boolean, ttl?: number): void {
    if (!ownerId || !viewerId) return;

    if (this.cache.size >= this.config.maxSize) {
      const evictCount = Math.max(1, Math.floor(this.config.maxSize * 0.1));
      this.evictOldest(evictCount);
    }

    const key = this.generateKey(ownerId, viewerId);
    this.cache.set(key, {
      isBlocked,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL,
    });
  }

  invalidate(ownerId: string, viewerId: string): void {
    if (!ownerId || !viewerId) return;
    const key = this.generateKey(ownerId, viewerId);
    this.cache.delete(key);
  }

  invalidateUser(userId: string): void {
    if (!userId) return;
    for (const [key] of this.cache.entries()) {
      if (key.startsWith(`${userId}:`) || key.endsWith(`:${userId}`)) {
        this.cache.delete(key);
      }
    }
  }

  private evictOldest(count = 1): void {
    if (count <= 0 || this.cache.size === 0) {
      return;
    }

    if (count === 1) {
      let oldestKey: string | null = null;
      let oldestTimestamp = Number.POSITIVE_INFINITY;

      for (const [key, cached] of this.cache.entries()) {
        if (cached.timestamp < oldestTimestamp) {
          oldestTimestamp = cached.timestamp;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    } else {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toEvict = entries.slice(0, Math.min(count, entries.length));
      for (const [key] of toEvict) {
        this.cache.delete(key);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > cached.ttl) {
        this.cache.delete(key);
      }
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    this.cleanupTimer.unref?.();
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
    };
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

const blockCache = new BlockCache();
const restrictCache = new BlockCache();
export { restrictCache };
export default blockCache;
