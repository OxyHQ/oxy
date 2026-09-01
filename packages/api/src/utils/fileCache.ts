import type { FileRecord } from '../types/file.types';

interface CachedFile {
  file: FileRecord;
  timestamp: number;
  ttl: number;
}

interface FileCacheConfig {
  maxSize: number;
  defaultTTL: number; // in milliseconds
  cleanupInterval: number; // in milliseconds
}

class FileCache {
  private cache: Map<string, CachedFile> = new Map();
  private config: FileCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<FileCacheConfig> = {}) {
    this.config = {
      maxSize: 50000,
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      cleanupInterval: 60 * 1000, // 1 minute
      ...config
    };

    this.startCleanupTimer();
  }

  get(fileId: string): FileRecord | null {
    if (!fileId) return null;

    const cached = this.cache.get(fileId);

    if (!cached) {
      return null;
    }

    const now = Date.now();
    if (now - cached.timestamp > cached.ttl) {
      this.cache.delete(fileId);
      return null;
    }

    return cached.file;
  }

  set(fileId: string, file: FileRecord, ttl?: number): void {
    if (!fileId || !file) return;

    if (this.cache.size >= this.config.maxSize) {
      const evictCount = Math.max(1, Math.floor(this.config.maxSize * 0.1));
      this.evictOldest(evictCount);
    }

    this.cache.set(fileId, {
      file,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL
    });
  }

  invalidate(fileId: string): void {
    if (fileId) {
      this.cache.delete(fileId);
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
      maxSize: this.config.maxSize
    };
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

const fileCache = new FileCache();
export default fileCache;
