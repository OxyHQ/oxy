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
 * ## The fail-open guard this port removes
 *
 * `isUserBlocked` and `isUserRestricted` used to open with
 *
 * ```ts
 * const objectIdRegex = /^[0-9a-f]{24}$/i;
 * if (!objectIdRegex.test(ownerId) || !objectIdRegex.test(viewerId)) return false;
 * ```
 *
 * and `false` from those methods means NOT BLOCKED / NOT RESTRICTED. So any id
 * that was not 24 hex characters SKIPPED block and restrict enforcement
 * entirely and the media was served — no error, no log. It was written to do two
 * things at once: recognise the `__federation__`-style sentinel owners, and stop
 * a non-ObjectId string reaching Mongo as a `CastError`. Both are gone here:
 *
 * - A system-owned asset is now `owner_user_id is null` plus a `system_owner`
 *   value (`schema/files.ts`), so the sentinel is a NULL check rather than a
 *   guess at a string's shape — total, and impossible to get wrong for an id
 *   format nobody anticipated.
 * - `blocks.user_id` and `restrictions.user_id` are `text` columns compared with
 *   bound parameters, so an id of any shape is a value, never a cast and never
 *   an operator.
 *
 * The guard is therefore deleted rather than adapted. It was inert only while
 * every id happened to be 24-hex; new rows carry uuid v7 ids
 * (`@oxy.so/db`'s `generatedId()`), which the regex rejects — under the old code every
 * post-cutover account would have silently bypassed block and restrict
 * enforcement on media. `__tests__/mediaPrivacyService.test.ts` pins this:
 * reinstate the regex and the blocked-viewer case goes red.
 */
export class MediaPrivacyService {
  /**
   * comprehensive access check for media files
   */
  async checkMediaAccess(
    file: FileRecord,
    viewerUserId?: string,
    context?: MediaAccessContext
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

      const groups = await getEquivalentUserGroups([ownerId, viewerUserId, context?.authorId].filter((id): id is string => !!id));
      const [external] = await getDb().select({ id: users.id }).from(users).where(and(inArray(users.id, Object.keys(groups)), eq(users.type, 'federated'))).limit(1);
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
  private async isUserBlocked(ownerId: string, viewerId: string, groups?: Record<string, string[]>, useCache = false): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([ownerId, viewerId]);
    const cached = useCache ? blockCache.get(ownerId, viewerId) : null;
    if (cached !== null) return cached;
    const [row] = await getDb()
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        or(
          and(inArray(blocks.userId, groups[ownerId] ?? [ownerId]), inArray(blocks.blockedId, groups[viewerId] ?? [viewerId])),
          and(inArray(blocks.userId, groups[viewerId] ?? [viewerId]), inArray(blocks.blockedId, groups[ownerId] ?? [ownerId]))
        )
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
  private async isUserRestricted(ownerId: string, viewerId: string, groups?: Record<string, string[]>, useCache = false): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([ownerId, viewerId]);
    const cached = useCache ? restrictCache.get(ownerId, viewerId) : null;
    if (cached !== null) return cached;
    const [row] = await getDb()
      .select({ id: restrictions.id })
      .from(restrictions)
      .where(and(inArray(restrictions.userId, groups[ownerId] ?? [ownerId]), inArray(restrictions.restrictedId, groups[viewerId] ?? [viewerId])))
      .limit(1);

    const isRestricted = row !== undefined;
    if (useCache) restrictCache.set(ownerId, viewerId, isRestricted);
    return isRestricted;
  }

  /**
   * Does `followerId` follow `followedId`?
   *
   * Mongo answered this by loading the target account and scanning its
   * `followers[]` array — a whole user document (plus a userCache entry holding
   * it) to learn one boolean. `users.followers[]` no longer exists: the edge
   * lives in `user_follows`, where the compound unique makes this a point read.
   */
  private async isFollowing(followerId: string, followedId: string, groups?: Record<string, string[]>): Promise<boolean> {
    groups ??= await getEquivalentUserGroups([followerId, followedId]);
    const [row] = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(inArray(userFollows.followerId, groups[followerId] ?? [followerId]), inArray(userFollows.followedId, groups[followedId] ?? [followedId])))
      .limit(1);

    return row !== undefined;
  }

  /**
   * Check entity-level permissions.
   *
   * `authorId` is caller-supplied. Mongo needed an `ObjectId.isValid` gate here
   * so a user-shaped value could not reach the query as a query OPERATOR; a
   * bound `text` parameter cannot be one, and an id matching no follow edge is
   * denied by the same branch a missing author was. The gate is therefore gone
   * without any behaviour changing.
   */
  private async checkEntityAccess(
    context: MediaAccessContext,
    viewerUserId?: string,
    groups?: Record<string, string[]>
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
