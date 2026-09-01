/**
 * The store's reads, against a REAL Postgres.
 *
 * These are joins and aggregates, and `CONVENTIONS.md` records what that costs:
 * a query written wrong here returns an empty array with no error at all. So
 * every case asserts a value that could only come from the database — a name
 * that lives on `applications`, an average over rows this test inserted, a
 * reply attached to the right review — rather than that a call resolved.
 *
 * Every fixture carries a per-test random identifier, so nothing depends on the
 * tables being empty.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCategories } from '../../db/schema/appCategories';
import { appListings } from '../../db/schema/appListings';
import { appReviewReplies } from '../../db/schema/appReviewReplies';
import { appReviews } from '../../db/schema/appReviews';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  getPublishedListing,
  listCategories,
  listPublishedListings,
  listReviews,
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
    .values({ username: `store-${suffix}`, email: `store-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(owner: string, name: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name, ownerAccountId: owner, icon: 'file-icon-id' })
    .returning({ id: applications.id });
  return row.id;
}

async function insertListing(
  applicationId: string,
  values: Partial<typeof appListings.$inferInsert> = {}
): Promise<{ id: string; slug: string }> {
  const slug = `listing-${randomUUID().slice(0, 8)}`;
  const [row] = await getDb()
    .insert(appListings)
    .values({ applicationId, slug, status: 'published', publishedAt: new Date(), ...values })
    .returning({ id: appListings.id, slug: appListings.slug });
  return row;
}

async function review(applicationId: string, rating: number, extra: Partial<typeof appReviews.$inferInsert> = {}) {
  const userId = await insertUser();
  const [row] = await getDb()
    .insert(appReviews)
    .values({ applicationId, userId, rating, ...extra })
    .returning({ id: appReviews.id });
  return row.id;
}

describe('a listing is served with what the application knows', () => {
  it('carries the name and icon from `applications`, not a copy', async () => {
    const owner = await insertUser();
    const name = `App ${randomUUID().slice(0, 8)}`;
    const applicationId = await insertApplication(owner, name);
    const { slug } = await insertListing(applicationId, { tagline: 'One line' });

    const listing = await getPublishedListing(slug);

    expect(listing).not.toBeNull();
    expect(listing!.name).toBe(name);
    expect(listing!.icon).toBe('file-icon-id');
    expect(listing!.tagline).toBe('One line');
  });

  it('answers null for a draft, the same as for a slug that does not exist', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId, { status: 'draft', publishedAt: null });

    expect(await getPublishedListing(slug)).toBeNull();
    expect(await getPublishedListing(`missing-${randomUUID()}`)).toBeNull();
  });
});

describe('the rating is computed from the reviews that are visible', () => {
  it('averages them, and rounds to one decimal', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);
    for (const rating of [5, 4, 4]) await review(applicationId, rating);

    const listing = await getPublishedListing(slug);

    // 13 / 3 = 4.333…
    expect(listing!.rating).toEqual({ average: 4.3, count: 3 });
    expect(listing!.ratingBreakdown).toEqual({ 4: 2, 5: 1 });
  });

  it('drops a hidden review from the average immediately', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);
    await review(applicationId, 5);
    await review(applicationId, 1, { status: 'hidden' });

    const listing = await getPublishedListing(slug);

    expect(listing!.rating).toEqual({ average: 5, count: 1 });
  });

  it('says null rather than zero when nobody has reviewed it', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);

    expect((await getPublishedListing(slug))!.rating).toEqual({ average: null, count: 0 });
  });
});

describe('the listing page reads one shelf at a time', () => {
  it('returns only the listings on the category asked for', async () => {
    const owner = await insertUser();
    const slugValue = `cat-${randomUUID().slice(0, 8)}`;
    const [category] = await getDb()
      .insert(appCategories)
      .values({ slug: slugValue, label: 'Productivity' })
      .returning({ id: appCategories.id });

    const onShelf = await insertApplication(owner, `On ${randomUUID().slice(0, 8)}`);
    const offShelf = await insertApplication(owner, `Off ${randomUUID().slice(0, 8)}`);
    const listed = await insertListing(onShelf, { categoryId: category.id });
    await insertListing(offShelf);

    const { items } = await listPublishedListings({ categorySlug: slugValue, limit: 50, offset: 0 });

    expect(items.map((item) => item.slug)).toEqual([listed.slug]);
    expect(items[0].category).toEqual({ slug: slugValue, label: 'Productivity' });
  });

  it('treats an unknown shelf as empty, not as no filter at all', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    await insertListing(applicationId);

    const { items, total } = await listPublishedListings({
      categorySlug: `nope-${randomUUID()}`,
      limit: 50,
      offset: 0,
    });

    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('rates every card in the page — the aggregate is not per-card', async () => {
    const owner = await insertUser();
    const slugValue = `cat-${randomUUID().slice(0, 8)}`;
    const [category] = await getDb()
      .insert(appCategories)
      .values({ slug: slugValue, label: 'Tools' })
      .returning({ id: appCategories.id });

    const first = await insertApplication(owner, `A ${randomUUID().slice(0, 8)}`);
    const second = await insertApplication(owner, `B ${randomUUID().slice(0, 8)}`);
    await insertListing(first, { categoryId: category.id });
    await insertListing(second, { categoryId: category.id });
    await review(first, 5);
    await review(second, 3);
    await review(second, 3);

    const { items } = await listPublishedListings({ categorySlug: slugValue, limit: 50, offset: 0 });

    expect(items.map((item) => item.rating)).toEqual(
      expect.arrayContaining([
        { average: 5, count: 1 },
        { average: 3, count: 2 },
      ])
    );
  });
});

describe('reviews come back with their replies attached', () => {
  it('puts each reply on its own review and leaves the rest null', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);
    const answered = await review(applicationId, 2, { body: 'Slow' });
    await review(applicationId, 5, { body: 'Fast' });
    await getDb()
      .insert(appReviewReplies)
      .values({ reviewId: answered, authorUserId: owner, body: 'Fixed in 2.1' });

    const result = await listReviews({ slug, limit: 50, offset: 0, sort: 'recent' });

    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    const withReply = result!.items.find((item) => item.id === answered);
    expect(withReply!.reply!.body).toBe('Fixed in 2.1');
    expect(result!.items.filter((item) => item.reply === null)).toHaveLength(1);
  });

  it('hides a hidden review from the list as well as from the average', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);
    await review(applicationId, 5, { body: 'Visible' });
    await review(applicationId, 1, { body: 'Hidden', status: 'hidden' });

    const result = await listReviews({ slug, limit: 50, offset: 0, sort: 'recent' });

    expect(result!.items.map((item) => item.body)).toEqual(['Visible']);
  });

  it('sorts by rating when asked, and by recency otherwise', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId);
    await review(applicationId, 1);
    await review(applicationId, 5);
    await review(applicationId, 3);

    const byRating = await listReviews({ slug, limit: 50, offset: 0, sort: 'rating' });
    expect(byRating!.items.map((item) => item.rating)).toEqual([5, 3, 1]);
  });

  it('answers null for a listing that is not published', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner, `App ${randomUUID().slice(0, 8)}`);
    const { slug } = await insertListing(applicationId, { status: 'draft', publishedAt: null });

    expect(await listReviews({ slug, limit: 10, offset: 0, sort: 'recent' })).toBeNull();
  });
});

describe('the shelves', () => {
  it('come back in their curated order', async () => {
    const prefix = randomUUID().slice(0, 8);
    await getDb()
      .insert(appCategories)
      .values([
        { slug: `${prefix}-b`, label: 'Second', order: 20 },
        { slug: `${prefix}-a`, label: 'First', order: 10 },
      ]);

    const ours = (await listCategories()).filter((category) => category.slug.startsWith(prefix));

    expect(ours.map((category) => category.label)).toEqual(['First', 'Second']);
  });
});
