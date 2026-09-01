/**
 * Users Controller
 * 
 * Controller for user-related operations that require more complex logic
 * or don't fit into the standard service pattern.
 */

import type { Request, Response, NextFunction } from 'express';
import { and } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import { BadRequestError, InternalServerError } from '../utils/error';
import { sendSuccess } from '../utils/asyncHandler';
import {
  normalizePeopleSearchTerm,
  peopleSearchMatch,
  peopleSearchPredicate,
} from '../utils/profileQuery';
import { publicUserColumns, toPublicUserView } from '../utils/publicUserProjection';
import { formatUserResponse } from '../utils/userTransform';

export class UsersController {
  /**
   * POST /users/search
   * 
   * Search for users by username or name
   * 
   * @body {string} query - Search query string
   * @returns {User[]} Array of matching users (max 5)
   */
  async searchUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { query } = req.body;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        throw new BadRequestError('Search query is required and must be a non-empty string');
      }

      // Strip a single leading `@` (and trim) BEFORE sanitizing so a handle-style
      // query matches the STORED username: an atproto handle
      // `@adamrbjack.bsky.social` finds `adamrbjack.bsky.social@bsky.social`, and
      // a Mastodon `@user@host` matches `user@host`. Only ONE leading `@` is
      // removed — a mid-string `@` (the `user@host` separator) is preserved.
      // The term is passed RAW: `peopleSearchMatch` escapes it for LIKE and
      // binds it as a parameter, so escaping it here as well would make `a+b`
      // search for a literal backslash.
      const term = normalizePeopleSearchTerm(query);

      const rows = await getDb()
        .select(publicUserColumns)
        .from(users)
        .where(and(peopleSearchPredicate(), peopleSearchMatch(term)))
        .limit(5);

      const formattedUsers = rows
        .map((row) => formatUserResponse(toPublicUserView(row)))
        .filter((user): user is NonNullable<typeof user> => user !== null);

      logger.debug('User search performed', {
        query: term,
        resultsCount: formattedUsers.length,
      });

      sendSuccess(res, formattedUsers);
    } catch (error) {
      // Re-throw known errors
      if (error instanceof BadRequestError || error instanceof InternalServerError) {
        throw error;
      }

      // Log and wrap unexpected errors
      logger.error('Error in searchUsers:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw new InternalServerError('Failed to search users');
    }
  }
}

export default new UsersController(); 