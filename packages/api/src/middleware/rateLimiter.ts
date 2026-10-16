/**
 * Every HTTP rate limiter in oxy-api is built HERE, and only here: this is the
 * one module that imports `express-rate-limit` (`rateLimiterSingleSource.test.ts`).
 *
 * So every limiter answers a refusal the same way: 429, a `Retry-After` stating
 * when the caller's window resets, and the API's error shape with the typed code
 * `RATE_LIMITED` (`ApiError.toJSON`), or the nested `rate_limited` shape for the
 * surfaces that opted into it. Before, the global limiters answered their
 * message as a bare text body: a machine caller (Kaana authorizing a grant) had
 * no code to read and could only guess that "something in front of Oxy" had
 * turned it away.
 */

import expressRateLimit, { type AugmentedRequest } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import type { Request, Response } from 'express';
import { hashedIpKey } from '../utils/ipKey';
import { ApiError, ErrorCodes } from '../utils/error';

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
  /** Structured errors for new cross-product APIs. */
  errorFormat?: 'nested';
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
   * The global limiters (`security.ts`) also skip whole surfaces that another
   * limiter budgets (uploads, the IdP worker, federation, service credentials):
   * that is WHICH budget a request is charged to, decided in one visible place.
   */
  skip?: (req: Request) => boolean;
  /**
   * What a limited request is answered with, for a surface whose refusals have
   * a contract of their own (the grant API answers a public inference error;
   * {@link rateLimitRetryAfterMs} gives it the wait). Absent: the API's typed
   * `RATE_LIMITED` error with {@link RateLimitOptions.message}.
   */
  handler?: (req: Request, res: Response) => void;
}

const DEFAULT_MESSAGE = 'Too many requests, please try again later.';

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

/**
 * How long a request a limiter refused must wait: until its window resets, as
 * the store reported it, or a whole window when the store reports no reset.
 */
export function rateLimitRetryAfterMs(req: Request, windowMs: number): number {
  const resetTime = (req as AugmentedRequest).rateLimit?.resetTime;
  return resetTime === undefined ? windowMs : Math.max(0, resetTime.getTime() - Date.now());
}

/**
 * Answer a request that is over a limit: 429, `Retry-After` in whole seconds
 * (never 0: "retry now" is not what a refusal means) and the typed error. For
 * every limiter here and for the hand-rolled budgets (device-secret lockouts)
 * that cannot be an express-rate-limit middleware.
 */
export function sendRateLimited(
  res: Response,
  input: {
    readonly message: string;
    readonly retryAfterSeconds: number;
    readonly format?: 'nested';
  },
): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(input.retryAfterSeconds));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json(
    input.format === 'nested'
      ? {
          error: { code: 'rate_limited', message: input.message, details: { retryAfterSeconds } },
        }
      : new ApiError(429, input.message, ErrorCodes.RATE_LIMITED, { retryAfterSeconds }).toJSON(),
  );
}

export function rateLimit(options: RateLimitOptions) {
  const message = options.message ?? DEFAULT_MESSAGE;
  return expressRateLimit({
    ...makeStore(options.prefix),
    windowMs: options.windowMs,
    max: options.max,
    handler:
      options.handler ??
      ((req: Request, res: Response) =>
        sendRateLimited(res, {
          message,
          retryAfterSeconds: rateLimitRetryAfterMs(req, options.windowMs) / 1000,
          format: options.errorFormat,
        })),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: options.keyGenerator ?? hashedIpKey,
    ...(options.skip ? { skip: options.skip } : {}),
    // hashedIpKey already buckets IPv6 to /56 before HMAC (see ipKey.ts); the v8
    // static source scan false-positives on req.ip and spams ERR_ERL_KEY_GEN_IPV6.
    validate: { keyGeneratorIpFallback: false },
  });
}
