# Redis & Valkey

The Oxy API uses **AWS ElastiCache (Valkey)** — cluster `oxy-valkey` in `eu-west-1` — for distributed rate limiting and Socket.IO cross-instance broadcasting. Valkey is a Redis-compatible in-memory data store, so the Redis client and protocol are unchanged.

## What It's Used For

| Feature | Without Redis | With Redis |
|---------|---------------|------------|
| Rate limiting | In-memory (resets on restart, per-instance) | Shared across instances, survives restarts |
| Socket.IO | Single-instance only | Cross-instance broadcast via pub/sub |
| Health check | Reports `"not configured"` | Reports `"connected"` / `"disconnected"`; `503` once the client has ended |

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

### When Valkey is down

- The client never stops reconnecting (`redisRetryStrategy`: +200 ms per attempt, capped at 5 s).
  Its `duplicate()` subscribers inherit it and the BullMQ connections (`queue/connection.ts`) use
  it. It used to give up after 20 attempts (about 42 s), after which every command failed with
  "Connection is closed" until a deploy.
- Every limiter admits requests uncounted while the connection is not `ready`, and passes a store
  error from a connected client (`passOnStoreError`) instead of answering 500 — except the live
  session-authority and holder-evidence budgets, which fail closed with 503
  (`failClosedOnStoreError`, `runAuthorityBudget`). The in-memory `bruteForceProtection` slow-down
  never touches Valkey.
- `/health` answers `200 "degraded"` while the client reconnects (every task sees the same outage;
  replacing them would not help) and `503` with `redis: "ended"` if this task's client has ended,
  which only a new task fixes.
- Every command on the shared client is rejected after `REDIS_COMMAND_TIMEOUT_MS` (1 s), counted
  from the moment it is sent: queued while the client (re)connects, then awaiting its reply. Every
  caller falls back on a rejection (caches read the database, the lockout counts in memory, the
  infrastructure registry keeps its local view, the workload mint answers 503
  `challenge_store_unavailable`). Without it a command waited in ioredis's offline queue until
  `maxRetriesPerRequest` reconnect attempts had failed, up to a minute, for the whole outage.
  `enableOfflineQueue: false` was not used: it also rejects what is sent before the first connect.
- Subscribers take `duplicateRedisSubscriber(redis)`: the same connection settings without the
  command timeout, and `autoResubscribe`, so ioredis subscribes them again after a reconnect.
  BullMQ builds its own connections (`queue/connection.ts`, `maxRetriesPerRequest: null`).

### Authenticated account cache (`packages/api/src/utils/userCache.ts`)

A local miss returns immediately so the session service can read PostgreSQL; Redis
warm-fill never blocks authentication. Concurrent misses for the same account share
one background Redis read. A database `set`, invalidation (including peer events),
or `clear` invalidates that read's identity, so a delayed document cannot overwrite
fresh account data or restore revoked permissions. Completion only releases its
own read, preserving newer work after eviction. Pending warm-fills are bounded to
10,000 distinct accounts; at capacity PostgreSQL remains the fallback.

Regression evidence: `userCacheWarmFill.test.ts` uses delayed Redis replies to
exercise concurrent misses, fresh writes, invalidation, clearing, and read failure.

### Rate limiting (`packages/api/src/middleware/rateLimiter.ts`)

Every HTTP limiter — the global budgets in `security.ts` and every route's own — is built by
`rateLimit({ prefix, windowMs, max, … })` from `middleware/rateLimiter.ts`, the only module that
imports `express-rate-limit` (`rateLimiterRefusal.test.ts` enforces it). It uses a `RedisStore`
under the limiter's unique `prefix` when Redis is configured, and the in-memory store otherwise.
A limiter fails open when that store cannot count (see "When Valkey is down" above;
`rateLimiterStoreOutage.test.ts`).

A refused request is answered the same way by every limiter: `429`, `Retry-After` until the
caller's window resets, and the API error `{ "error": "RATE_LIMITED", "message", "details":
{ "retryAfterSeconds" } }` (or the nested `rate_limited` shape where a surface opted into
`errorFormat: 'nested'`), written by `sendRateLimited` (`middleware/errorHandler.ts`). Hand-rolled
budgets answer through the same `sendRateLimited`: the device-secret lockouts and the stats-stream
cap call it, and a service over a budget (sign-in and second-factor lockouts, the reauth mail
budget, Nominatim's refusal) throws a `RateLimitedError` that `errorHandler` and `asyncHandler`
answer with it — keeping a contract code of its own (`SIGN_IN_ERROR_CODES.locked`) where its
surface has one. `RateLimitedError` is the only 429 oxy-api builds (the same test). The grant API
and the inference edge answer their own public error vocabularies, each through its one sender
that sets `Retry-After`.

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
