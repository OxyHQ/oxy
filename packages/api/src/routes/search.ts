import express, { type Request, type Response } from "express";
import { and } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import {
  normalizePeopleSearchTerm,
  peopleSearchMatch,
  peopleSearchOrder,
  peopleSearchPredicate,
} from '../utils/profileQuery';
import { validate } from '../middleware/validate';
import { searchQuerySchema } from '../schemas/search.schemas';
import { publicUserColumns, toPublicUserView } from '../utils/publicUserProjection';
import { formatUserResponse } from '../utils/userTransform';

const router = express.Router();

type ValidatedSearchQuery = {
  query?: string;
  type?: 'all' | 'users';
  page: number;
  limit: number;
};

router.get("/", validate({ query: searchQuerySchema }), async (req: Request, res: Response) => {
  try {
    const { query, type = "all", page, limit } = req.query as unknown as ValidatedSearchQuery;
    const skip = (page - 1) * limit;

    // Strip a single leading `@` so handle-style queries match stored usernames
    // (same rule as GET /profiles/search and POST /users/search). The term is
    // passed RAW from here: `peopleSearchMatch` escapes it for LIKE and binds it
    // as a parameter, so escaping it a second time on the way in would make
    // `a+b` search for a literal backslash.
    const term = normalizePeopleSearchTerm((query as string) || '');

    const results: {
      users: NonNullable<ReturnType<typeof formatUserResponse>>[];
      pagination: { page: number; limit: number; hasMore: boolean };
    } = { users: [], pagination: { page, limit, hasMore: false } };

    if (type === "all" || type === "users") {
      // Ordered BEFORE paging (`peopleSearchOrder` ends on the unique `id`) so
      // offset pagination is a strict total order and a row can never appear on
      // two pages or be skipped between them.
      const rows = await getDb()
        .select(publicUserColumns)
        .from(users)
        .where(
          and(
            peopleSearchPredicate(),
            peopleSearchMatch(term, { includeLocations: true })
          )
        )
        .orderBy(...peopleSearchOrder())
        .offset(skip)
        .limit(limit);

      results.users = rows
        .map((row) => {
          const view = toPublicUserView(row);
          return formatUserResponse({
            ...view,
            // This surface has ALWAYS emitted only the public consent leaf —
            // its Mongo `$project` named `privacySettings.fediverseSharing` and
            // nothing else, while `POST /users/search` (a `.select()` that also
            // carried the discoverability gate) emits both. The two differ on
            // the wire today; the port keeps each exactly as it was.
            privacySettings: { fediverseSharing: view.privacySettings?.fediverseSharing },
          });
        })
        .filter((user): user is NonNullable<typeof user> => user !== null);
      results.pagination.hasMore = rows.length === limit;
    }

    res.json(results);
  } catch (error) {
    logger.error('Search error:', error);
    res.status(500).json({
      message: "Error performing search",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

export default router;
