/**
 * Media authorization, against a REAL Postgres.
 *
 * This file exists for ONE guarantee above all others, stated as a security gate
 * in `db/MIGRATION-CONTRACT.md`: **a blocked or restricted viewer is refused,
 * whatever the two account ids happen to look like.**
 *
 * The code this replaces opened both checks with
 *
 * ```ts
 * const objectIdRegex = /^[0-9a-f]{24}$/i;
 * if (!objectIdRegex.test(ownerId) || !objectIdRegex.test(viewerId)) return false;
 * ```
 *
 * and `false` there means NOT BLOCKED / NOT RESTRICTED — so a non-24-hex id
 * skipped enforcement entirely and the media was served, with no error and no
 * log. Every account created after the Postgres cutover carries a **uuid v7**
 * id, which that regex rejects. The guard was one migration away from opening
 * block and restrict on media for every new account.
 *
 * So the ids here are the ones `generatedId()` actually mints — uuid v7,
 * NOT-24-hex — rather than the hex literals the previous suite used. Under the
 * old guard those cases could not fail; under this one they are the point.
 * Reinstate the regex and `denies a blocked viewer` goes red naming the bypass.
 *
 * The suite runs against real rows: `blocks`, `restrictions`, `user_follows` and
 * `users` are queried through the application's own pool, so what is verified is
 * the predicate the server will actually execute, not a mock's idea of it.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { blocks, files, restrictions, userFollows, users } from '../../db/schema';
import type { FileRecord } from '../../types/file.types';
import blockCache, { restrictCache } from '../../utils/blockCache';
import { MediaPrivacyService } from '../mediaPrivacyService';

const service = new MediaPrivacyService();

async function insertUser(values: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...values })
    .returning({ id: users.id });
  return row.id;
}

/**
 * A stored asset owned by `ownerUserId`, read back so the record under test is
 * the row shape the service sees in production rather than a literal.
 */
async function insertFile(
  values: Partial<typeof files.$inferInsert> = {}
): Promise<FileRecord> {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(64, '0').slice(0, 64),
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      storageKey: `assets/${Math.random().toString(36).slice(2)}`,
      visibility: 'public',
      ...values,
    })
    .returning();
  return { ...row, links: [], variants: [] };
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(() => {
  // The two caches are process-wide and keyed on the id PAIR, so one case's
  // verdict would otherwise decide the next case's.
  blockCache.clear();
  restrictCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('the id format must not decide whether block/restrict is enforced', () => {
  it('denies a blocked viewer a public asset — with the uuid v7 ids new accounts carry', async () => {
    const ownerId = await insertUser();
    const viewerId = await insertUser();

    // The ids the schema actually generates. Spelling out WHY they matter: the
    // deleted guard tested `/^[0-9a-f]{24}$/` and returned "not blocked" on a
    // miss, so with these ids it would have skipped the block lookup entirely.
    expect(ownerId).not.toMatch(/^[0-9a-f]{24}$/i);
    expect(viewerId).not.toMatch(/^[0-9a-f]{24}$/i);

    await getDb().insert(blocks).values({ userId: ownerId, blockedId: viewerId });
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'blocked',
    });
  });

  it('denies the blocker too — a block is mutual', async () => {
    const ownerId = await insertUser();
    const viewerId = await insertUser();

    // The viewer blocked the OWNER, the opposite direction from the case above.
    await getDb().insert(blocks).values({ userId: viewerId, blockedId: ownerId });
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'blocked',
    });
  });

  it('denies a restricted viewer — again with non-hex ids', async () => {
    const ownerId = await insertUser();
    const viewerId = await insertUser();

    await getDb().insert(restrictions).values({ userId: ownerId, restrictedId: viewerId });
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'restricted',
    });
  });

  it('does not deny the reverse direction — restrict is asymmetric', async () => {
    const ownerId = await insertUser();
    const viewerId = await insertUser();

    // The VIEWER restricted the owner. That must not stop the viewer reading the
    // owner's media — unlike a block, which is mutual (case above).
    await getDb().insert(restrictions).values({ userId: viewerId, restrictedId: ownerId });
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: true,
      isPublic: true,
    });
  });
});

describe('a system-owned asset has no account to have blocked anyone', () => {
  it('serves it without consulting the block graph', async () => {
    const viewerId = await insertUser();
    // The namespace that used to be a sentinel STRING in `owner_user_id`, which
    // is why the id-shape guard existed at all. It is now its own column, and
    // `owner_user_id is null` is the exact, total discriminator.
    const file = await insertFile({
      ownerUserId: null,
      systemOwner: '__federation__',
      purpose: 'user',
    });

    expect(file.ownerUserId).toBeNull();
    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: true,
      isPublic: true,
    });
  });
});

describe('the rest of the ladder still holds', () => {
  it('allows the owner unconditionally', async () => {
    const ownerId = await insertUser();
    const file = await insertFile({ ownerUserId: ownerId, visibility: 'private' });

    expect(await service.checkMediaAccess(file, ownerId)).toEqual({
      allowed: true,
      reason: 'owner',
    });
  });

  it('serves a public asset to an anonymous viewer', async () => {
    const ownerId = await insertUser();
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file)).toEqual({ allowed: true, isPublic: true });
  });

  it('refuses a private asset to an anonymous viewer', async () => {
    const ownerId = await insertUser();
    const file = await insertFile({ ownerUserId: ownerId, visibility: 'private' });

    expect(await service.checkMediaAccess(file)).toEqual({
      allowed: false,
      reason: 'authentication_required',
    });
  });

  it('refuses a private-account owner\'s private asset to a non-follower', async () => {
    const ownerId = await insertUser({ privacyIsPrivateAccount: true });
    const viewerId = await insertUser();
    const file = await insertFile({ ownerUserId: ownerId, visibility: 'private' });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'not_following_private_account',
    });
  });

  it('serves it once the viewer follows', async () => {
    const ownerId = await insertUser({ privacyIsPrivateAccount: true });
    const viewerId = await insertUser();
    // `users.followers[]` is deleted; `user_follows` is the single authority.
    await getDb().insert(userFollows).values({ followerId: viewerId, followedId: ownerId });
    const file = await insertFile({ ownerUserId: ownerId, visibility: 'private' });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({ allowed: true });
  });

  it('gates a followers-only entity on the follow edge, not on the id format', async () => {
    const authorId = await insertUser();
    const viewerId = await insertUser();
    const file = await insertFile({ ownerUserId: authorId });

    const context = {
      app: 'mention',
      entityType: 'post',
      entityId: 'p1',
      postVisibility: 'followers',
      authorId,
    };

    expect(await service.checkMediaAccess(file, viewerId, context)).toEqual({
      allowed: false,
      reason: 'entity_access_denied',
    });

    await getDb().insert(userFollows).values({ followerId: viewerId, followedId: authorId });
    expect(await service.checkMediaAccess(file, viewerId, context)).toEqual({ allowed: true });
  });

  it('denies a followers-only entity whose author does not exist', async () => {
    // The deleted `ObjectId.isValid(authorId)` gate rejected a caller-supplied
    // author id by SHAPE, to keep it from reaching Mongo as a query operator. A
    // bound `text` parameter cannot be an operator, and an id naming no account
    // matches no follow edge — the same denial, from the data rather than from a
    // format check.
    const viewerId = await insertUser();
    const file = await insertFile({ ownerUserId: await insertUser() });

    expect(
      await service.checkMediaAccess(file, viewerId, {
        postVisibility: 'followers',
        authorId: '{"$ne": null}',
      })
    ).toEqual({ allowed: false, reason: 'entity_access_denied' });
  });

  it('caches the block verdict rather than re-querying', async () => {
    const ownerId = await insertUser();
    const viewerId = await insertUser();
    await getDb().insert(blocks).values({ userId: ownerId, blockedId: viewerId });
    const file = await insertFile({ ownerUserId: ownerId });

    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'blocked',
    });

    // Removing the row must NOT change the answer until the cache expires: that
    // is what proves the second call was served from the cache.
    await getDb().delete(blocks).where(eq(blocks.userId, ownerId));
    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: false,
      reason: 'blocked',
    });

    blockCache.clear();
    expect(await service.checkMediaAccess(file, viewerId)).toEqual({
      allowed: true,
      isPublic: true,
    });
  });
});
