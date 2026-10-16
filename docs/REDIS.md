# Redis & Valkey

The Oxy API uses **AWS ElastiCache (Valkey)** — cluster `oxy-valkey` in `eu-west-1` — for distributed rate limiting and Socket.IO cross-instance broadcasting. Valkey is a Redis-compatible in-memory data store, so the Redis client and protocol are unchanged.

## What It's Used For

| Feature | Without Redis | With Redis |
|---------|---------------|------------|
| Rate limiting | In-memory (resets on restart, per-instance) | Shared across instances, survives restarts |
| Socket.IO | Single-instance only | Cross-instance broadcast via pub/sub |
| Health check | Reports `"not configured"` | Reports `"connected"` / `"disconnected"` |

## Configuration

Set `REDIS_URL` in environment. Omit to fall back to in-memory (no breakage).

```bash
# Production (ElastiCache, in-VPC, TLS)
REDIS_URL=rediss://<private-valkey-endpoint>:6379

# Local development (optional)
# REDIS_URL=redis://localhost:6379
```

- `rediss://` = TLS (recommended for ElastiCache in transit)
- `redis://` = plaintext (local only)
- Omit = in-memory fallback

In production the value lives in SSM (the shared Redis URL parameter) and is injected into ECS tasks from the task definition.

## Implementation

### Redis client (`packages/api/src/config/redis.ts`)

Shared singleton with lazy connection and graceful null fallback:

```typescript
import Redis from 'ioredis';

export function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  // Returns shared instance, lazy-connects on first call
}

export async function closeRedis(): Promise<void> {
  // Called during graceful shutdown
}
```

### Rate limiting (`packages/api/src/middleware/rateLimiter.ts`)

Every HTTP limiter — the global budgets in `security.ts` and every route's own — is built by
`rateLimit({ prefix, windowMs, max, … })` from `middleware/rateLimiter.ts`, the only module that
imports `express-rate-limit` (`rateLimiterRefusal.test.ts` enforces it). It uses a `RedisStore`
under the limiter's unique `prefix` when Redis is configured, and the in-memory store otherwise.

A refused request is answered the same way by every limiter: `429`, `Retry-After` until the
caller's window resets, and the API error `{ "error": "RATE_LIMITED", "message", "details":
{ "retryAfterSeconds" } }` (or the nested `rate_limited` shape where a surface opted into
`errorFormat: 'nested'`). Hand-rolled budgets (device-secret lockouts) answer through the same
`sendRateLimited`.

### Socket.IO adapter (`packages/api/src/server.ts`)

Uses `@socket.io/redis-adapter` for cross-instance event broadcasting:

```typescript
import { createAdapter } from '@socket.io/redis-adapter';

const redis = getRedisClient();
if (redis) {
  io.adapter(createAdapter(redis.duplicate(), redis.duplicate()));
}
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `ioredis` | Redis/Valkey client |
| `rate-limit-redis` | Redis store for express-rate-limit |
| `@socket.io/redis-adapter` | Socket.IO multi-instance adapter |

## Caching strategy

The API has several in-memory caches that remain in-memory (not moved to Valkey):

| Cache | Max Entries | TTL | Purpose |
|-------|-----------|-----|---------|
| sessionCache | 5,000 | 5 min | Session validation results |
| userCache | 10,000 | 5 min | User profile lookups |
| blockCache | 100,000 | 1 min | User block relationships |
| fileCache | 50,000 | 5 min | File metadata |
| locationCache | 1,000 | 24 hr | Location search results |

These work well as fast L1 caches per task. Valkey serves as the distributed backbone for rate limiting and Socket.IO only.

## Networking

`oxy-valkey` lives in the same VPC as the ECS tasks. The cluster's security group only accepts traffic from the ECS task ENIs (matched by security group, not IP). It is not reachable from the public internet.
