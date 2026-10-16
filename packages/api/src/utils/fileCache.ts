import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../config/redis';
import type { FileRecord } from '../types/file.types';
import { logger } from './logger';

/**
 * The Redis channel every API task listens on for file-record invalidations
 * (`fileCacheInvalidationSubscriber.ts`). API-internal: no other service holds
 * this cache.
 */
export const FILE_CACHE_INVALIDATION_CHANNEL = 'oxy:file-cache:invalidate';

/** Ids per published message; a larger invalidation is split. */
export const FILE_CACHE_INVALIDATION_BATCH = 500;

/** The one message shape on {@link FILE_CACHE_INVALIDATION_CHANNEL}. */
export const fileCacheInvalidationMessageSchema = z
  .object({
    v: z.literal(1),
    /** The publishing process: it already dropped its own copies. */
    origin: z.string().min(1).max(64),
    fileIds: z.array(z.string().min(1).max(64)).min(1).max(FILE_CACHE_INVALIDATION_BATCH),
  })
  .strict();

export type FileCacheInvalidationMessage = z.infer<typeof fileCacheInvalidationMessageSchema>;

/** This process, as {@link FileCacheInvalidationMessage.origin}. */
export const FILE_CACHE_ORIGIN = `${process.pid}:${randomBytes(6).toString('hex')}`;

/**
 * How long an invalidation keeps refusing a record read BEFORE it: a read that
 * began before a write committed and finishes after the invalidation arrived
 * would otherwise put the old record back for the whole TTL.
 */
const RECENT_INVALIDATION_WINDOW_MS = 60 * 1000;
const RECENT_INVALIDATION_MAX_ENTRIES = 50_000;

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
  /** fileId → when it was last invalidated here (epoch ms), for {@link setIfFresh}. */
  private recentInvalidations: Map<string, number> = new Map();
  private config: FileCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<FileCacheConfig> = {}) {
    this.config = {
      maxSize: 50000,
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      cleanupInterval: 60 * 1000, // 1 minute
      ...config,
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
      ttl: ttl || this.config.defaultTTL,
    });
  }

  /**
   * Cache a record read from the database ONLY if no invalidation of it
   * arrived since the read began (`readStartedAt`, epoch ms). A read that
   * started before a write committed can finish after that write's
   * invalidation — from this task or another — and must not put the old
   * record back for the whole TTL. Returns whether it was cached.
   */
  setIfFresh(fileId: string, file: FileRecord, readStartedAt: number): boolean {
    const invalidatedAt = this.recentInvalidations.get(fileId);
    if (invalidatedAt !== undefined && invalidatedAt >= readStartedAt) return false;
    this.set(fileId, file);
    return true;
  }

  /**
   * The file's record changed (its status, visibility, keys, references…):
   * drop it here AND tell every other API task to drop theirs (ADR 0043 stage
   * 4b). Call it AFTER the write committed.
   *
   * This is the one entry point every transition already goes through
   * (`AssetService.cacheFile`, `enterServing`, `leaveServing`, the tombstone
   * path, application and account deletion), so making it cross-task is what
   * reaches them all — a separate "and also broadcast" call at each site would
   * be one more thing to forget. `fileCacheWriters.census.test.ts` holds every
   * write to `files` to a path that reaches it.
   *
   * Publishing never fails the caller: without Redis (or with Redis down) the
   * invalidation is local and other tasks fall back to the TTL.
   */
  invalidate(fileId: string): void {
    if (!fileId) return;
    this.invalidateMany([fileId]);
  }

  /** {@link invalidate} for many files, published in batches. */
  invalidateMany(fileIds: Iterable<string>): void {
    const ids = [...new Set([...fileIds].filter((id) => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return;
    this.invalidateLocal(ids);
    publishFileCacheInvalidation(ids);
  }

  /**
   * Drop these files here only, with no fan-out: what the subscriber does with
   * a peer's message (re-publishing it would loop).
   */
  invalidateLocal(fileIds: Iterable<string>): void {
    const now = Date.now();
    for (const fileId of fileIds) {
      if (!fileId) continue;
      this.cache.delete(fileId);
      this.recentInvalidations.delete(fileId);
      this.recentInvalidations.set(fileId, now);
    }
    while (this.recentInvalidations.size > RECENT_INVALIDATION_MAX_ENTRIES) {
      const oldest = this.recentInvalidations.keys().next().value;
      if (oldest === undefined) break;
      this.recentInvalidations.delete(oldest);
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
    for (const [key, at] of this.recentInvalidations) {
      // Insertion order is invalidation order: stop at the first recent one.
      if (now - at <= RECENT_INVALIDATION_WINDOW_MS) break;
      this.recentInvalidations.delete(key);
    }

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
    this.recentInvalidations.clear();
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

/**
 * Tell every other API task to drop these files. Fire-and-forget: it runs after
 * a committed write, a lost message costs a peer its TTL (never correctness of
 * the write), so nothing here may surface as an error. `getRedisClient()` is
 * never put in subscriber mode (subscribers take `duplicate()`s), so PUBLISH on
 * it is legal.
 */
function publishFileCacheInvalidation(fileIds: readonly string[]): void {
  let redis: ReturnType<typeof getRedisClient>;
  try {
    redis = getRedisClient();
  } catch (error) {
    logger.warn('fileCache: no Redis client for the invalidation', {
      err: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (redis?.status !== 'ready') return;
  for (let start = 0; start < fileIds.length; start += FILE_CACHE_INVALIDATION_BATCH) {
    const message: FileCacheInvalidationMessage = {
      v: 1,
      origin: FILE_CACHE_ORIGIN,
      fileIds: fileIds.slice(start, start + FILE_CACHE_INVALIDATION_BATCH),
    };
    try {
      redis.publish(FILE_CACHE_INVALIDATION_CHANNEL, JSON.stringify(message)).catch((error) => {
        logger.warn('fileCache: invalidation publish failed', {
          files: message.fileIds.length,
          err: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn('fileCache: invalidation publish failed', {
        files: message.fileIds.length,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const fileCache = new FileCache();
export default fileCache;
