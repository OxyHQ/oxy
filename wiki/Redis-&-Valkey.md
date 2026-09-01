# Redis & Valkey

The Oxy API uses **AWS ElastiCache (Valkey)** — cluster `oxy-valkey` in `us-west-2` — for distributed rate limiting and Socket.IO cross-instance broadcasting. Valkey is a Redis-compatible in-memory data store, so the client and protocol are unchanged.

## What It's Used For

| Feature | Without Redis | With Redis |
|---------|---------------|------------|
| Rate limiting | In-memory (resets on restart, per-instance) | Shared across instances, survives restarts |
| Socket.IO | Single-instance only (events don't cross processes) | Cross-instance broadcast via pub/sub |
| Health check | Reports `"not configured"` | Reports `"connected"` / `"disconnected"` |

## Architecture

```
+-------------+     +-------------+
| ECS task A  |     | ECS task B  |
+------+------+     +------+------+
       \                  /
        \                /
         v              v
       +----------------+
       |   oxy-valkey   |
       |  (ElastiCache, |
       |   in-VPC, TLS) |
       +----------------+
```

The Valkey cluster lives inside the same VPC as the ECS tasks. Its security group only accepts traffic from the ECS task ENIs.

## Configuration

Set `REDIS_URL` in the environment. If unset, everything falls back to in-memory with no breakage.

```bash
# Production (ElastiCache, in-VPC, TLS)
REDIS_URL=rediss://<private-valkey-endpoint>:6379

# Local development (optional)
# REDIS_URL=redis://localhost:6379
```

- `rediss://` = TLS (recommended for ElastiCache in transit)
- `redis://` = plaintext (local only)
- Omit = in-memory fallback

In production the value is stored in SSM (the shared Redis URL parameter) and injected into ECS tasks via the task definition `secrets` mapping.

## Implementation

### Redis client (`packages/api/src/config/redis.ts`)

```typescript
import Redis from 'ioredis';

export function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;  // Graceful fallback
  // Returns shared singleton, lazy-connects on first call
}

export async function closeRedis(): Promise<void> {
  // Called during graceful shutdown
}
```

### Rate limiting (`packages/api/src/middleware/security.ts`)

```typescript
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';

function makeStore() {
  const redis = getRedisClient();
  if (!redis) return {};  // Falls back to in-memory
  return {
    store: new RedisStore({
      sendCommand: (...args: string[]) =>
        redis.call(args[0], ...args.slice(1)),
    }),
  };
}

const rateLimiter = rateLimit({
  ...makeStore(),
  windowMs: 15 * 60 * 1000,
  max: 150,
});
```

### Socket.IO adapter (`packages/api/src/server.ts`)

```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import { getRedisClient } from './config/redis';

const redis = getRedisClient();
if (redis) {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
}
```

This makes Socket.IO rooms and events fan out across all ECS tasks.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `ioredis` | ^5.9 | Valkey client (Redis-compatible) |
| `rate-limit-redis` | ^4.3 | Redis store for express-rate-limit |
| `@socket.io/redis-adapter` | ^8.3 | Socket.IO multi-instance adapter |

## Graceful shutdown

Redis is closed during `SIGINT` / `SIGTERM` (ECS sends `SIGTERM` before killing the container):

```typescript
async function gracefulShutdown(signal: string) {
  // ...stop accepting work first, then release the backing stores
  await closeRedis();
  await closePostgres();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

## Health check

```bash
curl https://api.oxy.so/health
```

```json
{
  "status": "operational",
  "database": "connected",
  "redis": "connected"
}
```

Redis status values: `"connected"`, `"disconnected"`, `"not configured"`.

## Caching strategy

The API keeps several caches in-process. They are intentionally **not** moved to Valkey:

| Cache | Max entries | TTL | Purpose |
|-------|------------|-----|---------|
| sessionCache | 5,000 | 5 min | Session validation results |
| userCache | 10,000 | 5 min | User profile lookups |
| blockCache | 100,000 | 1 min | User block relationships |
| fileCache | 50,000 | 5 min | File metadata |
| locationCache | 1,000 | 24 hr | Location search results |

These work well as fast L1 caches per task. Valkey is the distributed backbone for rate limiting and Socket.IO only. If horizontal scaling demands it, individual caches can be migrated to Valkey as L2 in the future.

## Networking

`oxy-valkey`:
- Lives in the same VPC as the ECS tasks.
- Security group accepts `:6379` only from the ECS task security group (SG-to-SG rule).
- No public access; no IP allow-list maintenance.
