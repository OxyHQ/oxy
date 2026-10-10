import type { Socket } from 'socket.io';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_WINDOW_MS = 10_000;

export function createSocketRateLimiter(
  maxEvents = DEFAULT_MAX_EVENTS,
  windowMs = DEFAULT_WINDOW_MS,
) {
  // Fallback in-memory store when Redis is unavailable
  const localClients = new Map<string, { count: number; resetAt: number }>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of localClients) {
      if (now > state.resetAt + windowMs) localClients.delete(id);
    }
  }, windowMs * 2);
  if (cleanupInterval.unref) cleanupInterval.unref();

  return function rateLimitMiddleware(socket: Socket, next: (err?: Error) => void) {
    const redis = getRedisClient();
    const windowSec = Math.ceil(windowMs / 1000);

    socket.use(async (packet, ackNext) => {
      try {
        let count: number;

        if (redis && redis.status === 'ready') {
          const key = `socket_rl:${socket.id}`;
          count = await redis.incr(key);
          if (count === 1) await redis.expire(key, windowSec);
        } else {
          // In-memory fallback
          const now = Date.now();
          let state = localClients.get(socket.id);
          if (!state || now > state.resetAt) {
            state = { count: 0, resetAt: now + windowMs };
            localClients.set(socket.id, state);
          }
          state.count++;
          count = state.count;
        }

        if (count > maxEvents) {
          logger.warn('Socket rate limit exceeded, disconnecting', {
            socketId: socket.id,
            count,
            maxEvents,
          });
          socket.emit('error', { message: 'Rate limit exceeded' });
          socket.disconnect(true);
          return;
        }

        ackNext();
      } catch {
        // On Redis error, allow the event through
        ackNext();
      }
    });

    socket.on('disconnect', () => {
      localClients.delete(socket.id);
    });

    next();
  };
}
