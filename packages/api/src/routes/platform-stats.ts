/**
 * Platform statistics — eight staff-only counters, served over REST and SSE.
 *
 * ## Every counter must reach the client as a JSON NUMBER
 *
 * This is the one thing about this file that can break silently. Postgres
 * `count(*)` returns **bigint**, and the driver hands a bigint back as a
 * STRING, because it does not fit a JS `Number` safely. `res.json` serializes a
 * string as happily as a number, so a naive port turns `{ totalUsers: 42 }` into
 * `{ totalUsers: "42" }` with no error at any layer and every consumer's
 * arithmetic quietly wrong.
 *
 * Each count therefore goes through drizzle's `count()` aggregate, which carries
 * `.mapWith(Number)` and converts at the ORM boundary. Deliberately NOT
 * `count(*)::int`: `int4` tops out at 2^31-1, and `messages` / `user_follows`
 * are exactly the tables that can pass it — an overflow there would be a
 * Postgres error at read time on a live dashboard. `.mapWith(Number)` is exact
 * to 2^53 and degrades to a rounded number rather than a failure beyond it.
 *
 * `__tests__/platformStats.test.ts` asserts `typeof x === 'number'` for every
 * field, not just the value: a string `"42"` compares unequal to `42`, but a
 * test that only checked one counter's value would let the other seven regress.
 *
 * ## `activeSessions` gained an expiry predicate
 *
 * Mongo counted `{ isActive: true }` and relied on a TTL index to have already
 * removed expired rows. `sessions` is registered in `db/expiry.ts` with
 * `retentionSeconds: 0`, so the sweep is the port of that TTL — but nothing in
 * this codebase ever DELETES a session row (`schema/sessions.ts`: "`deactivate`
 * never DELETES"), which makes an unfiltered count depend on a background job
 * running for its answer to be right rather than merely tidy. That is the class
 * (B) read `schema/CONVENTIONS.md` says to move into class (A) at port time by
 * adding the read-side filter, and it is the same `is_active and expires_at >
 * now()` the Mongoose `isValid()` method already spelled out. With a healthy
 * sweep the number is identical to Mongo's; without one it is still correct.
 *
 * ## The wire format is otherwise byte-identical
 *
 * Same eight field names in the same order, plus the constant `aiModels` and an
 * ISO-8601 `timestamp`. `totalApplications` keeps its name — it was renamed from
 * the legacy developer-app model on purpose (`AGENTS.md`, "Application Model")
 * and must not drift back.
 */

import { Router, type Request, type Response } from 'express';
import { and, count, eq, gt } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { requireStaff } from '../middleware/requireStaff';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { files } from '../db/schema/files';
import { messages } from '../db/schema/messages';
import { notifications } from '../db/schema/notifications';
import { sessions } from '../db/schema/sessions';
import { transactions } from '../db/schema/transactions';
import { userFollows } from '../db/schema/userFollows';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';

const router = Router();

/**
 * The response body, exactly. Every counter is a `number`; the type is the
 * compile-time half of the guarantee the test asserts at runtime.
 */
interface PlatformStats {
  totalUsers: number;
  activeSessions: number;
  totalMessages: number;
  totalNotifications: number;
  totalFiles: number;
  totalTransactions: number;
  totalApplications: number;
  totalFollows: number;
  aiModels: number;
  timestamp: string;
}

/**
 * Distinct AI models the platform exposes. A constant in the Mongo version too —
 * nothing counts these, and inventing a query for them would be inventing data.
 */
const AI_MODEL_COUNT = 4;

// Shared cache for both REST and SSE
let cachedStats: PlatformStats | null = null;
let cacheTime = 0;
let inFlightStatsRefresh: Promise<PlatformStats> | null = null;
let activeStatsStreams = 0;
const CACHE_TTL = 2_000; // 2s cache for real-time feel
const MAX_ACTIVE_STATS_STREAMS = 25;

async function fetchStats(): Promise<PlatformStats> {
  const now = Date.now();
  if (cachedStats && now - cacheTime < CACHE_TTL) {
    return cachedStats;
  }

  if (inFlightStatsRefresh) {
    return inFlightStatsRefresh;
  }

  inFlightStatsRefresh = refreshStats(now).finally(() => {
    inFlightStatsRefresh = null;
  });

  return inFlightStatsRefresh;
}

/**
 * Read a one-row `count(*)` query as a number.
 *
 * The aggregate always produces exactly one row, so the `?? 0` is a type
 * narrowing rather than a real branch — but it keeps the return type honest
 * without a non-null assertion.
 */
async function total(query: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await query;
  return row?.n ?? 0;
}

async function refreshStats(now: number): Promise<PlatformStats> {
  const db = getDb();

  const [
    totalUsers,
    activeSessions,
    totalMessages,
    totalNotifications,
    totalFiles,
    totalTransactions,
    totalApplications,
    totalFollows,
  ] = await Promise.all([
    total(db.select({ n: count() }).from(users)),
    total(
      db
        .select({ n: count() })
        .from(sessions)
        .where(and(eq(sessions.isActive, true), gt(sessions.expiresAt, new Date())))
    ),
    total(db.select({ n: count() }).from(messages)),
    total(db.select({ n: count() }).from(notifications)),
    total(db.select({ n: count() }).from(files)),
    total(db.select({ n: count() }).from(transactions)),
    total(
      db.select({ n: count() }).from(applications).where(eq(applications.status, 'active'))
    ),
    total(db.select({ n: count() }).from(userFollows)),
  ]);

  const stats: PlatformStats = {
    totalUsers,
    activeSessions,
    totalMessages,
    totalNotifications,
    totalFiles,
    totalTransactions,
    totalApplications,
    totalFollows,
    aiModels: AI_MODEL_COUNT,
    timestamp: new Date().toISOString(),
  };

  cachedStats = stats;
  cacheTime = now;
  return stats;
}

router.use(authMiddleware, requireStaff);

// REST endpoint (fallback)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const stats = await fetchStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching platform stats:', error);
    res.status(500).json({ error: 'Failed to fetch platform statistics' });
  }
});

// SSE endpoint — true real-time push
router.get('/stream', (req: Request, res: Response) => {
  if (activeStatsStreams >= MAX_ACTIVE_STATS_STREAMS) {
    res.status(429).json({ error: 'Too many active platform stats streams' });
    return;
  }

  activeStatsStreams += 1;
  let closed = false;
  let sendInProgress = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable Nginx buffering
  });

  // Send initial data immediately
  const sendStats = async () => {
    if (closed || sendInProgress) {
      return;
    }

    sendInProgress = true;
    try {
      const stats = await fetchStats();
      if (!closed) {
        res.write(`data: ${JSON.stringify(stats)}\n\n`);
      }
    } catch (error) {
      logger.error('SSE stats error:', error);
    } finally {
      sendInProgress = false;
    }
  };

  // Send immediately, then every 2 seconds
  sendStats();
  const interval = setInterval(sendStats, 2_000);

  // Keep-alive ping every 15s to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    if (closed) {
      return;
    }

    closed = true;
    activeStatsStreams = Math.max(0, activeStatsStreams - 1);
    clearInterval(interval);
    clearInterval(keepAlive);
  });
});

export default router;
