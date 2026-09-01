/**
 * Analytics — the premium per-account activity surface (`/analytics`).
 *
 * Ported from `models/Analytics` + `models/User` onto `user_analytics` and the
 * `user_follows` social graph. Four things about this port are load-bearing.
 *
 * ## 1. The storage rename is INVISIBLE on the wire
 *
 * `schema/userAnalytics.ts` renames the collection `analytics` → `user_analytics`
 * and the column `userID` → `user_id`, because the capital-D spelling was unique
 * to that one model. Neither rename may reach a client: the response still
 * carries `userID`, and the request body's `data` keys are still the Mongo dot
 * paths (`stats.engagement.likes`, …) every existing caller sends.
 *
 * ## 2. The nested `stats` object is REBUILT at the serializer
 *
 * `stats.engagement.*`, `stats.reach.*`, `stats.demographics.*` and
 * `stats.peakActivity.*` are flat columns now. They are re-nested here, once, in
 * {@link serializeAnalyticsRow} — a client that reads `row.stats.reach.impressions`
 * keeps reading it.
 *
 * ## 3. A DOT PATH MUST NEVER REACH DRIZZLE
 *
 * Drizzle keys `set()` / `values()` by column PROPERTY and silently ignores a
 * key that names no column. `{ 'stats.engagement.likes': 5 }` would therefore
 * write NOTHING and throw NOTHING — the exact failure that shipped elsewhere in
 * this migration. Every wire dot path is translated through an explicit map
 * ({@link ANALYTICS_INCREMENT_DATA_COLUMNS}) whose values are real column
 * properties, so a typo is a compile error rather than a silent no-op.
 *
 * ## 4. `_count` is GONE, so growth is a MEASUREMENT
 *
 * `users._count.{followers,following}` were cached counters that existed only
 * because Mongo cannot JOIN (`schema/users.ts`). `user_follows` is the single
 * authority, so `growth` is `count(*)` over it and cannot disagree with the
 * edges.
 */

import type { Request, Response } from "express";
import { and, count, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AuthRequest } from "../middleware/auth";
import { getDb } from "../config/postgres";
import { qualified } from "@oxyhq/db";
import { ANALYTICS_PERIODS, userAnalytics } from "../db/schema/userAnalytics";
import { userFollows } from "../db/schema/userFollows";
import { users } from "../db/schema/users";
import { getDateRange } from "./utils/dateUtils";
import { logger } from '../utils/logger';

const getAuthenticatedAnalyticsUserId = (req: Request) => (req as AuthRequest).user?._id;

/** One aggregation window, as declared by the schema's closed value set. */
type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/**
 * Whether `value` names a real aggregation window.
 *
 * Mongo answered an unknown `period` with an empty result set rather than an
 * error (nothing matched the filter), and that is preserved: an unrecognised
 * value short-circuits to `[]` instead of reaching the query, which also keeps
 * the drizzle `eq()` honestly typed against the column's literal union.
 */
function isAnalyticsPeriod(value: string): value is AnalyticsPeriod {
  return (ANALYTICS_PERIODS as readonly string[]).includes(value);
}

/**
 * The `period` query parameter, exactly as Mongo saw it.
 *
 * A repeated or object-shaped `?period=` reached `getDateRange` as a non-string
 * (falling through to its weekly default) and reached the filter as a value no
 * document could equal. Normalising it to `''` reproduces both halves: the same
 * default window, and no matching row.
 */
function requestedPeriod(req: Request): string {
  const raw = req.query.period ?? 'weekly';
  return typeof raw === 'string' ? raw : '';
}

/** One `user_analytics` row's `stats` sub-object, in the shape clients read. */
interface AnalyticsStatsDto {
  postViews: number;
  profileViews: number;
  engagement: {
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    bookmarks: number;
  };
  reach: {
    impressions: number;
    uniqueViewers: number;
  };
  /**
   * Associative arrays over an OPEN key space (ISO country codes, BCP-47
   * language tags), stored as `jsonb` with no `$type`. `unknown` is the honest
   * TypeScript counterpart; Mongo's `Map` serialized to the same JSON object.
   */
  demographics: {
    countries: unknown;
    languages: unknown;
  };
  peakActivity: {
    hour: number;
    count: number;
  };
}

/**
 * One element of `timeSeriesData`.
 *
 * `_id` and `userID` keep their Mongo spellings — this is the serialized
 * document shape clients already consume. `__v` deliberately does NOT travel:
 * it is a driver artifact the migration contract forbids, and it carried no
 * meaning to any reader.
 *
 * The two `Date`s are handed to `res.json` as `Date` objects, exactly as the
 * Mongoose documents were, so both render as the same ISO-8601 strings.
 */
interface AnalyticsRowDto {
  _id: string;
  userID: string;
  period: AnalyticsPeriod;
  date: Date;
  stats: AnalyticsStatsDto;
  createdAt: Date;
  updatedAt: Date;
}

/** Re-nest one flat row into the documented `stats` tree. */
function serializeAnalyticsRow(row: typeof userAnalytics.$inferSelect): AnalyticsRowDto {
  return {
    _id: row.id,
    userID: row.userId,
    period: row.period,
    date: row.date,
    stats: {
      postViews: row.postViews,
      profileViews: row.profileViews,
      engagement: {
        likes: row.engagementLikes,
        replies: row.engagementReplies,
        reposts: row.engagementReposts,
        quotes: row.engagementQuotes,
        bookmarks: row.engagementBookmarks,
      },
      reach: {
        impressions: row.reachImpressions,
        uniqueViewers: row.reachUniqueViewers,
      },
      demographics: {
        countries: row.demographicsCountries,
        languages: row.demographicsLanguages,
      },
      peakActivity: {
        hour: row.peakActivityHour,
        count: row.peakActivityCount,
      },
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `growth` object: follower/following totals for one account.
 *
 * Empty when the account does not exist, which is what `userStats?._count || {}`
 * produced for a `findById` that found nothing.
 */
async function readGrowth(userId: string): Promise<{ followers: number; following: number } | Record<string, never>> {
  const db = getDb();
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) {
    return {};
  }

  const [followers, following] = await Promise.all([
    db.select({ n: count() }).from(userFollows).where(eq(userFollows.followedId, userId)),
    db.select({ n: count() }).from(userFollows).where(eq(userFollows.followerId, userId)),
  ]);

  return {
    followers: followers[0]?.n ?? 0,
    following: following[0]?.n ?? 0,
  };
}

export const getAnalytics = async (req: Request, res: Response) => {
  try {
    const userID = getAuthenticatedAnalyticsUserId(req);
    if (!userID) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const userId = String(userID);

    const period = requestedPeriod(req);
    const { startDate, endDate } = getDateRange(period);

    const analytics = isAnalyticsPeriod(period)
      ? await getDb()
          .select()
          .from(userAnalytics)
          .where(
            and(
              eq(userAnalytics.userId, userId),
              eq(userAnalytics.period, period),
              gte(userAnalytics.date, startDate),
              lte(userAnalytics.date, endDate)
            )
          )
          .orderBy(userAnalytics.date)
      : [];

    res.json({
      timeSeriesData: analytics.map(serializeAnalyticsRow),
      growth: await readGrowth(userId),
    });
  } catch (error) {
    logger.error('Error fetching analytics:', error);
    res.status(500).json({
      message: "Error fetching analytics",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

/**
 * Wire `type` → the counter column it increments.
 *
 * The KEYS are the request contract and keep their Mongo spelling; the VALUES
 * are drizzle column properties, so `set()` cannot silently ignore one.
 */
const ANALYTICS_INCREMENT_TYPE_COLUMNS = {
  postViews: 'postViews',
  profileViews: 'profileViews',
} as const;

/**
 * Wire `data` key → the counter column it increments.
 *
 * Every key is a Mongo DOT PATH, which is precisely why this map exists: handing
 * `'stats.engagement.likes'` straight to drizzle names no column, so the write
 * would be silently dropped. Nothing outside this table may be reached — the
 * whitelist is the authorization boundary as much as it is a translation.
 */
const ANALYTICS_INCREMENT_DATA_COLUMNS = {
  'stats.engagement.likes': 'engagementLikes',
  'stats.engagement.replies': 'engagementReplies',
  'stats.engagement.reposts': 'engagementReposts',
  'stats.engagement.quotes': 'engagementQuotes',
  'stats.engagement.bookmarks': 'engagementBookmarks',
  'stats.reach.impressions': 'reachImpressions',
  'stats.reach.uniqueViewers': 'reachUniqueViewers',
} as const;

/** Every column an increment may touch. */
type AnalyticsCounterColumn =
  | (typeof ANALYTICS_INCREMENT_TYPE_COLUMNS)[keyof typeof ANALYTICS_INCREMENT_TYPE_COLUMNS]
  | (typeof ANALYTICS_INCREMENT_DATA_COLUMNS)[keyof typeof ANALYTICS_INCREMENT_DATA_COLUMNS];

type AnalyticsIncrement = Partial<Record<AnalyticsCounterColumn, number>>;

const buildAnalyticsIncrement = (
  type: unknown,
  data: unknown,
): AnalyticsIncrement | null => {
  if (typeof type !== 'string' || !(type in ANALYTICS_INCREMENT_TYPE_COLUMNS)) {
    return null;
  }

  const increment: AnalyticsIncrement = {
    [ANALYTICS_INCREMENT_TYPE_COLUMNS[type as keyof typeof ANALYTICS_INCREMENT_TYPE_COLUMNS]]: 1,
  };

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (
        key in ANALYTICS_INCREMENT_DATA_COLUMNS &&
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        increment[
          ANALYTICS_INCREMENT_DATA_COLUMNS[key as keyof typeof ANALYTICS_INCREMENT_DATA_COLUMNS]
        ] = value;
      }
    }
  }

  return increment;
};

export const updateAnalytics = async (req: Request, res: Response) => {
  try {
    const userID = getAuthenticatedAnalyticsUserId(req);
    if (!userID) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const userId = String(userID);

    const { type, data } = req.body;
    const increment = buildAnalyticsIncrement(type, data);
    if (!increment) {
      return res.status(400).json({ message: 'Invalid analytics type' });
    }
    const date = new Date();

    // One statement instead of four round trips. `date` is the current instant,
    // so in practice every call INSERTS — the conflict arm exists because the
    // Mongo upsert had one, and because `(user_id, period, date)` is a real
    // unique constraint here rather than a hopeful index.
    //
    // The conflict arm ADDS to the stored value, exactly as `$inc` did. The
    // target table is named explicitly on the right-hand side via `qualified()`:
    // a bare column reference in an `ON CONFLICT DO UPDATE SET` expression is
    // one identifier away from meaning the PROPOSED row instead of the stored
    // one, and the wrong choice would overwrite the running total with the
    // delta.
    const bumped: Partial<Record<AnalyticsCounterColumn, SQL>> = {};
    for (const column of Object.keys(increment) as AnalyticsCounterColumn[]) {
      bumped[column] = sql`${qualified(userAnalytics[column])} + ${increment[column] ?? 0}`;
    }

    await getDb()
      .insert(userAnalytics)
      .values(
        ANALYTICS_PERIODS.map((period) => ({ userId, period, date, ...increment }))
      )
      .onConflictDoUpdate({
        target: [userAnalytics.userId, userAnalytics.period, userAnalytics.date],
        set: bumped,
      });

    res.json({ message: "Analytics updated successfully" });
  } catch (error) {
    logger.error('Error updating analytics:', error);
    res.status(500).json({
      message: "Error updating analytics",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

/**
 * `GET /analytics/viewers` — always an empty list, and always has been.
 *
 * The Mongo aggregation matched `{ "stats.viewers": { $exists: true } }` and
 * then unwound `$stats.viewers`. **No such field has ever existed**: the
 * `Analytics` schema declares `postViews`, `profileViews`, `engagement`,
 * `reach`, `demographics` and `peakActivity` and nothing else, and Mongoose's
 * strict mode drops an update path outside the schema — so neither
 * `updateAnalytics` nor any other writer could create one. The `$match`
 * therefore selected zero documents on every call this endpoint has ever served.
 *
 * `user_analytics` has no viewers column for the same reason: there is no data
 * to port. The endpoint keeps its `200 []` because that IS its wire contract,
 * and inventing a viewer log to back it would be inventing data rather than
 * migrating it.
 */
export const getContentViewers = (req: Request, res: Response) => {
  const userID = getAuthenticatedAnalyticsUserId(req);
  if (!userID) {
    return res.status(401).json({ message: "Authentication required" });
  }

  res.json([]);
};

/**
 * `GET /analytics/followers` — follower totals for the authenticated account.
 *
 * The Mongo version `$lookup`ed the embedded `users.followers` array against
 * `users`, then sized three filters over the joined documents. Both halves moved:
 * the array is deleted (`user_follows` is the authority) and the join is a real
 * one. The two windowed figures keep their original — and genuinely odd —
 * meaning: they count followers whose ACCOUNT was created or last updated inside
 * the window, not follow edges formed inside it. That is what the aggregation
 * computed, and the wire contract is the aggregation's output.
 */
export const getFollowerDetails = async (req: Request, res: Response) => {
  try {
    const userID = getAuthenticatedAnalyticsUserId(req);
    if (!userID) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const userId = String(userID);

    const period = requestedPeriod(req);
    const { startDate } = getDateRange(period);

    const db = getDb();
    const [account] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // `$match: { _id: <missing> }` produced no stage output at all, so the
    // controller fell through to its zeroed literal — which, unlike the matched
    // branch, carries no `_id`. Both shapes are preserved.
    if (!account) {
      return res.json({ totalFollowers: 0, newFollowers: 0, activeFollowers: 0 });
    }

    // The two windowed figures are `FILTER`ed aggregates over the SAME join, so
    // the three counts cost one pass rather than three queries.
    //
    // The predicates are built with `gte()` rather than written inline. A raw
    // `Date` interpolated into a `sql` fragment is bound with NO encoder, and
    // postgres.js then throws `ERR_INVALID_ARG_TYPE: Received an instance of
    // Date` at BIND time — before the statement ever reaches the server, so the
    // failure surfaces as an opaque "Failed query" with no SQL error behind it.
    // `gte()` wraps the value with the column's own encoder.
    const [row] = await db
      .select({
        totalFollowers: count(),
        newFollowers: sql<number>`count(*) filter (where ${gte(users.createdAt, startDate)})::int`,
        activeFollowers: sql<number>`count(*) filter (where ${gte(users.updatedAt, startDate)})::int`,
      })
      .from(userFollows)
      .innerJoin(users, eq(users.id, userFollows.followerId))
      .where(eq(userFollows.followedId, userId));

    res.json({
      _id: account.id,
      totalFollowers: row?.totalFollowers ?? 0,
      newFollowers: row?.newFollowers ?? 0,
      activeFollowers: row?.activeFollowers ?? 0,
    });
  } catch (error) {
    logger.error('Error fetching follower details:', error);
    res.status(500).json({
      message: "Error fetching follower details",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};
