/**
 * The store's writes, against a REAL Postgres.
 *
 * The reads' suite explains why these run against a database rather than a
 * mock; the writes have a second reason. Three of the rules here are enforced
 * by the schema and by nothing else — `unique(application_id, user_id)`,
 * `unique(review_id)` and `rating between 1 and 5` — so a test that stubbed the
 * driver would be testing the stub's opinion of them.
 *
 * The permission cases are the ones worth reading closely: they build a real
 * `account_members` row and assert that the SAME call succeeds or throws purely
 * on the role, so a check that stopped consulting the account graph would fail
 * here rather than ship.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { appGrants } from '../../db/schema/appGrants';
import { appListings } from '../../db/schema/appListings';
import { appReviewReplies } from '../../db/schema/appReviewReplies';
import { appReviews } from '../../db/schema/appReviews';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { ForbiddenError, NotFoundError } from '../../utils/error';
import {
  deleteOwnReview,
  deleteReply,
  getOwnReview,
  listReviews,
  upsertReply,
  upsertReview,
} from '../store.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function insertUser(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `writer-${suffix}`, email: `writer-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

/** A published app owned by a fresh account, which is the shape a write needs. */
async function publishedApp(): Promise<{ slug: string; applicationId: string; ownerId: string }> {
  const ownerId = await insertUser();
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId: ownerId })
    .returning({ id: applications.id });
  const slug = `listing-${randomUUID().slice(0, 8)}`;
  await getDb()
    .insert(appListings)
    .values({
      applicationId: application.id,
      slug,
      status: 'published',
      publishedAt: new Date(),
    });
  return { slug, applicationId: application.id, ownerId };
}

/** Give `memberId` a role on `accountId`, the way the account graph grants one. */
async function grantRole(
  accountId: string,
  memberId: string,
  role: 'editor' | 'viewer',
  deltas: { permissionRevokes?: string[] } = {}
) {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId: memberId,
    role,
    status: 'active',
    permissionRevokes: deltas.permissionRevokes ?? [],
  });
}

describe('writing a review', () => {
  it('stores what was written, and hands it straight back', async () => {
    const { slug } = await publishedApp();
    const userId = await insertUser();

    const review = await upsertReview({ slug, userId, rating: 4, title: 'Good', body: 'Works.' });

    expect(review.rating).toBe(4);
    expect(review.title).toBe('Good');
    expect(review.status).toBe('visible');
    expect(await getOwnReview({ slug, userId })).toMatchObject({ id: review.id, rating: 4 });
  });

  it('replaces the same person’s review rather than adding a second', async () => {
    const { slug, applicationId } = await publishedApp();
    const userId = await insertUser();

    const first = await upsertReview({ slug, userId, rating: 1, body: 'Broken' });
    const second = await upsertReview({ slug, userId, rating: 5, body: 'Fixed now' });

    expect(second.id).toBe(first.id);
    expect(second.body).toBe('Fixed now');
    const stored = await getDb().select().from(appReviews).where(eq(appReviews.applicationId, applicationId));
    expect(stored).toHaveLength(1);
  });

  it('keeps a hidden review hidden when its author rewrites it', async () => {
    const { slug, applicationId } = await publishedApp();
    const userId = await insertUser();
    await upsertReview({ slug, userId, rating: 1, body: 'Abusive' });
    await getDb().update(appReviews).set({ status: 'hidden' }).where(eq(appReviews.applicationId, applicationId));

    const rewritten = await upsertReview({ slug, userId, rating: 5, body: 'Polite now' });

    expect(rewritten.status).toBe('hidden');
    const page = await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' });
    expect(page!.items).toEqual([]);
  });

  it('stores a blank title as absent rather than as an empty string', async () => {
    const { slug } = await publishedApp();
    const userId = await insertUser();

    const review = await upsertReview({ slug, userId, rating: 3, title: '   ', body: 'Fine' });

    expect(review.title).toBeNull();
  });

  it('refuses a rating the database would not accept', async () => {
    const { slug } = await publishedApp();
    const userId = await insertUser();

    // The route's zod schema 400s this first; the CHECK is what makes it true
    // of the data, so it has to hold when the route is not in the picture.
    await expect(upsertReview({ slug, userId, rating: 9 })).rejects.toThrow();
  });

  it('will not attach a review to a listing that is not published', async () => {
    const ownerId = await insertUser();
    const [application] = await getDb()
      .insert(applications)
      .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId: ownerId })
      .returning({ id: applications.id });
    const slug = `draft-${randomUUID().slice(0, 8)}`;
    await getDb().insert(appListings).values({ applicationId: application.id, slug, status: 'draft' });

    await expect(upsertReview({ slug, userId: await insertUser(), rating: 5 })).rejects.toThrow(
      NotFoundError
    );
  });
});

describe('withdrawing a review', () => {
  it('removes the row rather than marking it', async () => {
    const { slug, applicationId } = await publishedApp();
    const userId = await insertUser();
    await upsertReview({ slug, userId, rating: 2 });

    await deleteOwnReview({ slug, userId });

    expect(await getDb().select().from(appReviews).where(eq(appReviews.applicationId, applicationId))).toEqual([]);
  });

  it('says so when there is nothing of yours to withdraw', async () => {
    const { slug } = await publishedApp();

    await expect(deleteOwnReview({ slug, userId: await insertUser() })).rejects.toThrow(NotFoundError);
  });

  it('withdraws only the caller’s own, never a neighbour’s', async () => {
    const { slug } = await publishedApp();
    const mine = await insertUser();
    const theirs = await insertUser();
    await upsertReview({ slug, userId: mine, rating: 1 });
    await upsertReview({ slug, userId: theirs, rating: 5 });

    await deleteOwnReview({ slug, userId: mine });

    const page = await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' });
    expect(page!.items.map((item) => item.author.id)).toEqual([theirs]);
  });
});

describe('the publisher’s reply is the account graph’s decision', () => {
  it('lets the owner of the app answer', async () => {
    const { slug, ownerId } = await publishedApp();
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 2 })).id;

    const reply = await upsertReply({ reviewId, authorUserId: ownerId, body: 'Sorry, fixed in 2.1' });

    expect(reply.reviewId).toBe(reviewId);
    const page = await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' });
    expect(page!.items[0].reply!.body).toBe('Sorry, fixed in 2.1');
  });

  it('lets a member whose role carries app:update answer', async () => {
    const { slug, ownerId } = await publishedApp();
    const editor = await insertUser();
    await grantRole(ownerId, editor, 'editor');
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 3 })).id;

    await expect(upsertReply({ reviewId, authorUserId: editor, body: 'Noted' })).resolves.toMatchObject({
      body: 'Noted',
    });
  });

  it('refuses an editor whose apps:update was REVOKED per member (issue #978)', async () => {
    // The same role, the same seeded app, one delta apart. The gate reads the
    // member's EFFECTIVE account permissions, so a revoke written on the
    // membership row reaches the store as it reaches `/accounts/*`.
    const { slug, ownerId } = await publishedApp();
    const revoked = await insertUser();
    const control = await insertUser();
    await grantRole(ownerId, revoked, 'editor', { permissionRevokes: ['apps:update'] });
    await grantRole(ownerId, control, 'editor');
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 3 })).id;

    await expect(
      upsertReply({ reviewId, authorUserId: revoked, body: 'Not mine to answer' })
    ).rejects.toThrow(ForbiddenError);
    await expect(
      upsertReply({ reviewId, authorUserId: control, body: 'Answered' })
    ).resolves.toMatchObject({ body: 'Answered' });
  });

  it('refuses a member whose role does not — the same person, one role apart', async () => {
    const { slug, ownerId } = await publishedApp();
    const viewer = await insertUser();
    await grantRole(ownerId, viewer, 'viewer');
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 3 })).id;

    await expect(upsertReply({ reviewId, authorUserId: viewer, body: 'Nope' })).rejects.toThrow(
      ForbiddenError
    );
  });

  it('refuses a stranger, and the review’s own author', async () => {
    const { slug } = await publishedApp();
    const author = await insertUser();
    const reviewId = (await upsertReview({ slug, userId: author, rating: 1 })).id;

    await expect(upsertReply({ reviewId, authorUserId: author, body: 'I answer myself' })).rejects.toThrow(
      ForbiddenError
    );
    await expect(
      upsertReply({ reviewId, authorUserId: await insertUser(), body: 'Hello' })
    ).rejects.toThrow(ForbiddenError);
  });

  it('rewrites the one reply rather than adding a second, and re-attributes it', async () => {
    const { slug, ownerId } = await publishedApp();
    const editor = await insertUser();
    await grantRole(ownerId, editor, 'editor');
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 2 })).id;

    await upsertReply({ reviewId, authorUserId: ownerId, body: 'First answer' });
    const second = await upsertReply({ reviewId, authorUserId: editor, body: 'Better answer' });

    const stored = await getDb().select().from(appReviewReplies).where(eq(appReviewReplies.reviewId, reviewId));
    expect(stored).toHaveLength(1);
    expect(stored[0].authorUserId).toBe(editor);
    expect(second.body).toBe('Better answer');
  });

  it('withdraws a reply under the same gate that wrote it', async () => {
    const { slug, ownerId } = await publishedApp();
    const viewer = await insertUser();
    await grantRole(ownerId, viewer, 'viewer');
    const reviewId = (await upsertReview({ slug, userId: await insertUser(), rating: 4 })).id;
    await upsertReply({ reviewId, authorUserId: ownerId, body: 'Thanks' });

    await expect(deleteReply({ reviewId, authorUserId: viewer })).rejects.toThrow(ForbiddenError);
    await deleteReply({ reviewId, authorUserId: ownerId });

    expect(await getDb().select().from(appReviewReplies).where(eq(appReviewReplies.reviewId, reviewId))).toEqual([]);
  });

  it('answers 404 for a review that does not exist, without consulting a role', async () => {
    await expect(
      upsertReply({ reviewId: `missing-${randomUUID()}`, authorUserId: await insertUser(), body: 'x' })
    ).rejects.toThrow(NotFoundError);
  });
});

describe('a reviewer who has authorized the app is marked as one', () => {
  it('reads the mark from `app_grants`, and drops it when consent is revoked', async () => {
    const { slug, applicationId } = await publishedApp();
    const consenting = await insertUser();
    const passerby = await insertUser();
    await upsertReview({ slug, userId: consenting, rating: 5 });
    await upsertReview({ slug, userId: passerby, rating: 1 });
    await getDb().insert(appGrants).values({ userId: consenting, applicationId, scopes: ['read'] });

    const withGrant = await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' });
    const marks = new Map(withGrant!.items.map((item) => [item.author.id, item.authorUsesApp]));
    expect(marks.get(consenting)).toBe(true);
    expect(marks.get(passerby)).toBe(false);

    await getDb().delete(appGrants).where(and(eq(appGrants.userId, consenting), eq(appGrants.applicationId, applicationId)));

    const afterRevoke = await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' });
    expect(afterRevoke!.items.every((item) => item.authorUsesApp === false)).toBe(true);
  });
});
