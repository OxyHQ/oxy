import { Router, type Response } from 'express';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { type Database, type DatabaseOrTransaction, getDb } from '../config/postgres';
import { refreshCreditsIfNeeded } from '../db/credits';
import { apiKeyUsageEvents } from '../db/schema/apiKeyUsageEvents';
import { userCredits } from '../db/schema/userCredits';
import { logger } from '../utils/logger';
import { validate } from '../middleware/validate';
import { creditsUsageQuerySchema } from '../schemas/credits.schemas';

const router = Router();

/** Days of usage history each `period` value covers. */
const USAGE_PERIOD_DAYS = { '7d': 7, '30d': 30 } as const;

/** One row of `user_credits`, as every caller here reads it. */
export type UserCreditsRow = typeof userCredits.$inferSelect;

/**
 * The account's credit row, creating it with the schema defaults if this is the
 * first time the account has been billed.
 *
 * The Mongoose original was `findByIdAndUpdate(userId, {$setOnInsert: …},
 * {upsert: true, new: true})` and restated all five defaults inline. Here the
 * defaults live on the table, so the insert supplies only the key.
 *
 * `onConflictDoNothing` is what makes this safe against two concurrent first
 * calls: the loser writes nothing rather than raising a duplicate-key error, and
 * the follow-up SELECT — a fresh snapshot under READ COMMITTED — sees the row the
 * winner committed. Never a read-then-insert, which has a window between the two.
 *
 * @throws When `userId` is not an existing account. `user_credits.user_id` is a
 *   real foreign key now, so an id with no account behind it fails here instead
 *   of silently minting an orphan balance the way Mongo's upsert did.
 */
export async function getOrCreateUserCredits(
  db: DatabaseOrTransaction,
  userId: string
): Promise<UserCreditsRow> {
  const [inserted] = await db
    .insert(userCredits)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(userCredits)
    .where(eq(userCredits.userId, userId));
  return existing;
}

// Get credit balance
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const db: Database = getDb();
    await getOrCreateUserCredits(db, userId);
    // The refresh is a guarded UPDATE, so its outcome is not knowable in advance
    // and the row must be re-read afterwards rather than patched in JavaScript.
    await refreshCreditsIfNeeded(db, userId);
    const [credits] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, userId));

    res.json({
      credits: credits.creditsFree + credits.creditsPaid,
      freeCredits: credits.creditsFree,
      paidCredits: credits.creditsPaid,
      dailyRefresh: credits.creditsDailyRefresh,
      lastRefresh: credits.creditsLastRefresh,
    });
  } catch (error) {
    logger.error('Error fetching credits:', error);
    res.status(500).json({ error: 'Failed to fetch credits' });
  }
});

// Get daily credit usage history
router.get('/usage', authMiddleware, validate({ query: creditsUsageQuerySchema }), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const period = req.query.period === '30d' ? '30d' : '7d';
    const days = USAGE_PERIOD_DAYS[period];
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // The Mongo `$group` on a `$dateToString` of the event timestamp, and its
    // `$cond`: bill the recorded credits when there are any, else one credit per
    // started 1000 tokens with a floor of 1.
    //
    // `at time zone 'UTC'` is load-bearing, not decoration. A bare
    // `date_trunc('day', <timestamptz>)` truncates in the SESSION's `TimeZone`,
    // so the day a row lands in would depend on server configuration — while
    // Mongo's `$dateToString` grouped in UTC and the gap-fill below keys on
    // `toISOString()`, which is UTC too. Naming the zone is what keeps the
    // grouping and the keys it is matched against the same calendar.
    //
    // `api_key_usage_events.created_at` IS the Mongoose `timestamp` field — see
    // that table's docblock; the rename is invisible to this response, which
    // emits its own `date` key.
    const usage = await getDb()
      .select({
        day: sql<string>`to_char(date_trunc('day', ${apiKeyUsageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        used: sql<number>`sum(
          case when ${apiKeyUsageEvents.creditsUsed} > 0
            then ${apiKeyUsageEvents.creditsUsed}
            else greatest(ceil(${apiKeyUsageEvents.tokensUsed}::numeric / 1000), 1)
          end
        )::double precision`,
      })
      .from(apiKeyUsageEvents)
      .where(
        and(
          eq(apiKeyUsageEvents.userId, userId),
          gte(apiKeyUsageEvents.createdAt, since),
          or(sql`${apiKeyUsageEvents.creditsUsed} > 0`, sql`${apiKeyUsageEvents.tokensUsed} > 0`)
        )
      )
      .groupBy(sql`date_trunc('day', ${apiKeyUsageEvents.createdAt} at time zone 'UTC')`);

    // Fill gaps with zeros
    const usageMap = new Map(usage.map((row) => [row.day, row.used]));
    const result: { date: string; used: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, used: usageMap.get(key) ?? 0 });
    }

    res.json(result);
  } catch (error) {
    logger.error('Error fetching credit usage:', error);
    res.status(500).json({ error: 'Failed to fetch credit usage' });
  }
});

export default router;
