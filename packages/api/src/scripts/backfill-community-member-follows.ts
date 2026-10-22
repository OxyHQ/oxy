#!/usr/bin/env bun
/**
 * One-shot backfill: every active member of a hosted community follows it.
 *
 * Why it exists: joining a community is following it, and its operators are
 * among its members (`joinCommunityAsOperator`). Until that rule existed, a
 * community's creator became its owner and moderator without following it — so
 * they were missing from its member count, its joined list and its `Group`'s
 * followers collection. Creation and invitation acceptance now join it in the
 * same transaction; this repairs the communities created before.
 *
 * Scope: hosted communities (`kind = 'community'`, `type = 'local'`, not
 * archived) and their DIRECT active memberships — the rows creation and
 * acceptance write. A federated community's members live on its own server.
 *
 * Idempotent: a member who already follows is skipped, and the follow command
 * absorbs a race. Each community is one transaction through the same
 * `joinCommunityAsOperator` the write paths use, so the relationship, its
 * `follow.created` event and the `user_follows` edge are the rows an ordinary
 * join writes.
 *
 *   bun run packages/api/src/scripts/backfill-community-member-follows.ts --dry-run
 *   bun run packages/api/src/scripts/backfill-community-member-follows.ts --apply
 *
 * Env: DATABASE_URL (required).
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { accountMembers } from '../db/schema/accountMembers';
import { userFollows } from '../db/schema/userFollows';
import { users } from '../db/schema/users';
import { joinCommunityAsOperator } from '../services/account.service';
import { invalidateAccountGraphCaches } from '../services/followCommand.service';
import { logger } from '../utils/logger';

export interface CommunityMemberFollowsReport {
  communityId: string;
  handle: string | null;
  followersBefore: number;
  followersAfter: number;
  /** Active direct members who did not follow it (followed under `apply`). */
  missing: { userId: string; handle: string | null; role: string }[];
}

async function followerCount(communityId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(userFollows)
    .where(eq(userFollows.followedId, communityId));
  return row?.n ?? 0;
}

export async function backfillCommunityMemberFollows(options: {
  apply: boolean;
}): Promise<CommunityMemberFollowsReport[]> {
  const db = getDb();
  const communities = await db
    .select({ id: users.id, kind: users.kind, handle: users.username })
    .from(users)
    .where(
      and(
        eq(users.kind, 'community'),
        eq(users.type, 'local'),
        ne(users.accountStatus, 'archived'),
      ),
    );

  const reports: CommunityMemberFollowsReport[] = [];
  for (const community of communities) {
    const members = await db
      .select({
        userId: accountMembers.memberUserId,
        handle: users.username,
        role: accountMembers.role,
      })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.memberUserId))
      .where(and(eq(accountMembers.accountId, community.id), eq(accountMembers.status, 'active')));
    const following = new Set(
      members.length === 0
        ? []
        : (
            await db
              .select({ followerId: userFollows.followerId })
              .from(userFollows)
              .where(
                and(
                  eq(userFollows.followedId, community.id),
                  inArray(
                    userFollows.followerId,
                    members.map((member) => member.userId),
                  ),
                ),
              )
          ).map((row) => row.followerId),
    );
    const missing = members.filter((member) => !following.has(member.userId));
    const followersBefore = await followerCount(community.id);

    if (options.apply && missing.length > 0) {
      const joined = await db.transaction(async (tx) => {
        const ids: string[] = [];
        for (const member of missing) {
          if (await joinCommunityAsOperator(tx, community, member.userId)) ids.push(member.userId);
        }
        return ids;
      });
      for (const userId of joined) await invalidateAccountGraphCaches(userId, [community.id]);
    }

    reports.push({
      communityId: community.id,
      handle: community.handle,
      followersBefore,
      followersAfter: options.apply ? await followerCount(community.id) : followersBefore,
      missing,
    });
  }
  return reports;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) {
    console.error('Pass exactly one of --dry-run or --apply.');
    process.exit(2);
  }

  await connectPostgres();
  try {
    const reports = await backfillCommunityMemberFollows({ apply });
    for (const report of reports) {
      logger.info(
        apply ? 'Community members joined' : 'DRY RUN — community members that would join',
        { ...report },
      );
    }
    logger.info(apply ? 'Community member follows backfilled' : 'DRY RUN complete', {
      communities: reports.length,
      missing: reports.reduce((sum, report) => sum + report.missing.length, 0),
    });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      'backfill-community-member-follows failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  });
}
