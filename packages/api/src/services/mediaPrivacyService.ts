import blockCache, { restrictCache } from '../utils/blockCache';
import { and, eq, or, inArray } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { blocks, restrictions, userFollows, users } from '../db/schema';
import { logger } from '../utils/logger';
import type { FileRecord } from '../types/file.types';
import type { MediaAccessContext, MediaAccessResult } from '../types/mediaPrivacy.types';
import { getEquivalentUserGroups } from './externalIdentityRegistry.service';

/**
 * Authorization for reading a stored asset.
 *
 * ## No id-shape guard — it would fail open
 *
 * `isUserBlocked` and `isUserRestricted` must NOT open with
 *
 * ```ts
 * const objectIdRegex = /^[0-9a-f]{24}$/i;
 * if (!objectIdRegex.test(ownerId) || !objectIdRegex.test(viewerId)) return false;
 * ```
 *
 * because `false` from those methods means NOT BLOCKED / NOT RESTRICTED. Any id
 * that is not 24 hex characters would SKIP block and restrict enforcement
 * entirely and the media would be served — no error, no log. Neither thing such
 * a guard might be for needs it:
 *
 * - A system-owned asset is `owner_user_id is null` plus a `system_owner`
 *   value (`schema/files.ts`), so the sentinel is a NULL check rather than a
 *   guess at a string's shape — total, and impossible to get wrong for an id
 *   format nobody anticipated.
 * - `blocks.user_id` and `restrictions.user_id` are `text` columns compared with
 *   bound parameters, so an id of any shape is a value, never a cast and never
 *   an operator.
 *
 * Ids are either legacy 24-hex ids or uuid v7 (`@oxy.so/db`'s `generatedId()`),
 * which the regex rejects — so with it, every uuid-id account would silently
 * bypass block and restrict enforcement on media.
 * `__tests__/mediaPrivacyService.test.ts` pins this: reinstate the regex and the
 * blocked-viewer case goes red.
 */
export class MediaPrivacyService {
  /**
   * comprehensive access check for media files
   */
  async checkMediaAccess(
    file: FileRecord,
    viewerUserId?: string,
    context?: MediaAccessContext,
  ): Promise<MediaAccessResult> {
    try {
      // NULL means a system namespace owns this asset (`files.system_owner`);
      // no account can be its owner and no account can have blocked it.
      const ownerId = file.ownerUserId;
      const isOwner = Boolean(viewerUserId) && ownerId === viewerUserId;

      if (isOwner) {
        return { allowed: true, reason: 'owner' };
      }

      // Public files without a specific entity context are accessible without authentication.
      // Authenticated viewers still pass through the block check below so social
      // privacy controls apply before public media is served.
      if (file.visibility === 'public' && !context && !viewerUserId) {
        return { allowed: true, isPublic: true };
      }

      if (file.visibility === 'private' && !viewerUserId) {
        return { allowed: false, reason: 'authentication_required' };
      }

      const groups = await getEquivalentUserGroups(
        [ownerId, viewerUserId, context?.authorId].filter((id): id is string => !!id),
      );
      const [external] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, Object.keys(groups)), eq(users.type, 'federated')))
        .limit(1);
      const useCache = !external;
      if (viewerUserId && ownerId) {
        const isBlocked = await this.isUserBlocked(ownerId, viewerUserId, groups, useCache);
        if (isBlocked) {
          return { allowed: false, reason: 'blocked' };
        }

        const isRestricted = await this.isUserRestricted(ownerId, viewerUserId, groups, useCache);
        if (isRestricted) {
          return { allowed: false, reason: 'restricted' };
        }
      }

      if (file.visibility !== 'public' && file.visibility !== 'unlisted' && ownerId) {
        const [owner] = await getDb()
          .select({ isPrivateAccount: users.privacyIsPrivateAccount })
          .from(users)
          .where(eq(users.id, ownerId))
          .limit(1);

        if (owner?.isPrivateAccount) {
          if (!viewerUserId) {
            return { allowed: false, reason: 'private_account' };
          }

          if (!(await this.isFollowing(viewerUserId, ownerId, groups))) {
            return { allowed: false, reason: 'not_following_private_account' };
          }
        }
      }

      if (context) {
        const entityAccess = await this.checkEntityAccess(context, viewerUserId, groups);
        if (!entityAccess.allowed) {
          return { allowed: false, reason: 'entity_access_denied' };
        }
      }

      if (file.visibility === 'public' && !context) {
        return { allowed: true, isPublic: true };
      }

      return { allowed: true };
    } catch (error) {
      logger.error('Error in checkMediaAccess:', error);
      return { allowed: false, reason: 'error' };
    }
  }

  /**
   * Block is MUTUAL: either direction denies. One indexed query answers both,
   * which is what `blocks(blocked_id)` was added for.
   */
  private async isUserBlocked(
    ownerId: string,
    viewerId: string,
    groups?: Record<string, string[]>,
    useCache = false,
  ): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([ownerId, viewerId]);
    const cached = useCache ? blockCache.get(ownerId, viewerId) : null;
    if (cached !== null) return cached;
    const [row] = await getDb()
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        or(
          and(
            inArray(blocks.userId, groups[ownerId] ?? [ownerId]),
            inArray(blocks.blockedId, groups[viewerId] ?? [viewerId]),
          ),
          and(
            inArray(blocks.userId, groups[viewerId] ?? [viewerId]),
            inArray(blocks.blockedId, groups[ownerId] ?? [ownerId]),
          ),
        ),
      )
      .limit(1);

    const isBlocked = row !== undefined;
    if (useCache) blockCache.set(ownerId, viewerId, isBlocked);
    return isBlocked;
  }

  /**
   * Restrict is asymmetric: when the media owner has restricted the viewer,
   * the viewer cannot access the owner's media (unlike block, which is mutual).
   */
  private async isUserRestricted(
    ownerId: string,
    viewerId: string,
    groups?: Record<string, string[]>,
    useCache = false,
  ): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([ownerId, viewerId]);
    const cached = useCache ? restrictCache.get(ownerId, viewerId) : null;
    if (cached !== null) return cached;
    const [row] = await getDb()
      .select({ id: restrictions.id })
      .from(restrictions)
      .where(
        and(
          inArray(restrictions.userId, groups[ownerId] ?? [ownerId]),
          inArray(restrictions.restrictedId, groups[viewerId] ?? [viewerId]),
        ),
      )
      .limit(1);

    const isRestricted = row !== undefined;
    if (useCache) restrictCache.set(ownerId, viewerId, isRestricted);
    return isRestricted;
  }

  /**
   * Does `followerId` follow `followedId`?
   *
   * The edge lives in `user_follows`, where the compound unique makes this a
   * point read.
   */
  private async isFollowing(
    followerId: string,
    followedId: string,
    groups?: Record<string, string[]>,
  ): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([followerId, followedId]);
    const [row] = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(
        and(
          inArray(userFollows.followerId, groups[followerId] ?? [followerId]),
          inArray(userFollows.followedId, groups[followedId] ?? [followedId]),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * Check entity-level permissions.
   *
   * `authorId` is caller-supplied. It is a bound `text` parameter, so it can
   * never act as a query operator, and an id matching no follow edge is denied
   * by the same branch as a missing author. No id-shape gate is needed.
   */
  private async checkEntityAccess(
    context: MediaAccessContext,
    viewerUserId?: string,
    groups?: Record<string, string[]>,
  ): Promise<{ allowed: boolean }> {
    const { postVisibility, authorId } = context;

    if (postVisibility) {
      if (postVisibility === 'public') return { allowed: true };
      if (postVisibility === 'private' && !viewerUserId) return { allowed: false };

      if (authorId && viewerUserId) {
        if (authorId === viewerUserId) return { allowed: true };

        if (postVisibility === 'followers') {
          return { allowed: await this.isFollowing(viewerUserId, authorId, groups) };
        }
      }
    }

    return { allowed: true };
  }
}

export const mediaPrivacyService = new MediaPrivacyService();
