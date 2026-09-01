import expressRateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import type { Request } from 'express';
import { hashedIpKey } from '../utils/ipKey';

interface RateLimitOptions {
  /**
   * Required: unique key prefix for the Redis store of THIS limiter. When
   * multiple limiters share a single Redis store without prefixes, a request
   * that flows through more than one of them increments the same counter
   * multiple times (express-rate-limit emits `ERR_ERL_DOUBLE_COUNT` and the
   * effective per-IP budget is silently halved). Use a short, stable, unique
   * string per call site, e.g. `'auth:challenge:'`, `'auth:device:bootstrap:'`.
   */
  prefix: string;
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  /**
   * Skip this limiter entirely for a request.
   *
   * For limiters whose KEY only exists once an earlier middleware has resolved a
   * principal — the machine-credential limiters key on `credentialId` /
   * `applicationId`, which a session-authenticated request on the same route
   * simply does not have. Without this they would bucket every such request
   * under one shared key and exhaust it for everybody; with it they measure only
   * the traffic they are about.
   *
   * A `skip` must be the NEGATION of "the key exists", never a policy decision:
   * anything that decides whether a caller deserves a limit belongs in the
   * route, where it is visible.
   */
  skip?: (req: Request) => boolean;
}

function makeStore(prefix: string) {
  const redis = getRedisClient();
  if (!redis) return {};
  return {
    store: new RedisStore({
      prefix,
      sendCommand: (...args: string[]) =>
        redis.call(args[0], ...args.slice(1)) as Promise<RedisReply>,
    }),
  };
}

export function rateLimit(options: RateLimitOptions) {
  return expressRateLimit({
    ...makeStore(options.prefix),
    windowMs: options.windowMs,
    max: options.max,
    message: options.message || 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: options.keyGenerator ?? hashedIpKey,
    ...(options.skip ? { skip: options.skip } : {}),
    // hashedIpKey already buckets IPv6 to /56 before HMAC (see ipKey.ts); the v8
    // static source scan false-positives on req.ip and spams ERR_ERL_KEY_GEN_IPV6.
    validate: { keyGeneratorIpFallback: false },
  });
}
