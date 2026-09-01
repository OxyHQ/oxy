/**
 * The app-store cluster — listings, screenshots, reviews and replies — against
 * a REAL Postgres.
 *
 * One `describe` per decision the schema files argue for, because each of them
 * is the kind a comment cannot keep true: which deletes cascade and which
 * refuse, that a review outlives the page it was shown on, and that the two
 * uniqueness rules are enforced by the database rather than by whichever route
 * happened to check first.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { appCategories } from '../appCategories';
import { appListingScreenshots } from '../appListingScreenshots';
import { appListings } from '../appListings';
import { appReviewReplies } from '../appReviewReplies';
import { appReviews } from '../appReviews';
import { applications } from '../applications';
import { files } from '../files';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A user row, which every other fixture hangs off. */
async function insertUser(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `store-${suffix}`, email: `store-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertCategory(): Promise<string> {
  const [row] = await getDb()
    .insert(appCategories)
    .values({ slug: `cat-${randomUUID().slice(0, 8)}`, label: 'Productivity' })
    .returning({ id: appCategories.id });
  return row.id;
}

async function insertListing(applicationId: string, categoryId?: string): Promise<string> {
  const [row] = await getDb()
    .insert(appListings)
    .values({ applicationId, slug: `listing-${randomUUID().slice(0, 8)}`, categoryId })
    .returning({ id: appListings.id });
  return row.id;
}

async function insertReview(applicationId: string, userId: string, rating = 5): Promise<string> {
  const [row] = await getDb()
    .insert(appReviews)
    .values({ applicationId, userId, rating, body: 'Fine.' })
    .returning({ id: appReviews.id });
  return row.id;
}

/**
 * The SQLSTATE a driver error carries. Drizzle wraps a driver failure in its own
 * `DrizzleQueryError`, so the code lives on the `cause` — walking the chain is
 * what stops every assertion below from degrading into "some error happened".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Await a query, expecting it to reject, and return the error. Awaiting a
 * drizzle query builder twice RUNS it twice, so this issues exactly one
 * statement.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

describe('a listing belongs to exactly one application', () => {
  it('refuses a second listing for the same application', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    await insertListing(applicationId);

    expect(pgErrorCode(await rejection(insertListing(applicationId)))).toBe(UNIQUE_VIOLATION);
  });

  it('refuses two listings with the same slug', async () => {
    const owner = await insertUser();
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const first = await insertApplication(owner);
    const second = await insertApplication(owner);

    await getDb().insert(appListings).values({ applicationId: first, slug });

    expect(pgErrorCode(await rejection(getDb().insert(appListings).values({ applicationId: second, slug })))).toBe(UNIQUE_VIOLATION);
  });

  it('goes with the application it describes', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const listingId = await insertListing(applicationId);

    await getDb().delete(applications).where(eq(applications.id, applicationId));

    const rows = await getDb().select().from(appListings).where(eq(appListings.id, listingId));
    expect(rows).toEqual([]);
  });
});

describe('retiring a category does not retire the apps on it', () => {
  it('leaves the listing, uncategorised', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const categoryId = await insertCategory();
    const listingId = await insertListing(applicationId, categoryId);

    await getDb().delete(appCategories).where(eq(appCategories.id, categoryId));

    const [row] = await getDb().select().from(appListings).where(eq(appListings.id, listingId));
    expect(row).toBeDefined();
    expect(row.categoryId).toBeNull();
  });
});

describe('a screenshot cannot outlive its file', () => {
  it('refuses to delete a file a published page still draws', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const listingId = await insertListing(applicationId);
    const [file] = await getDb()
      .insert(files)
      .values({
        sha256: randomUUID().replace(/-/g, ''),
        size: 1,
        mime: 'image/png',
        ext: 'png',
        ownerUserId: owner,
        storageKey: `screenshots/${randomUUID()}.png`,
      })
      .returning({ id: files.id });

    await getDb()
      .insert(appListingScreenshots)
      .values({ listingId, fileId: file.id, caption: 'Home' });

    expect(pgErrorCode(await rejection(getDb().delete(files).where(eq(files.id, file.id))))).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('the rating is one to five, in the database', () => {
  it.each([0, 6, -1])('refuses %i', async (rating) => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);

    expect(pgErrorCode(await rejection(insertReview(applicationId, owner, rating)))).toBe(CHECK_VIOLATION);
  });

  it.each([1, 3, 5])('accepts %i', async (rating) => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    await expect(insertReview(applicationId, owner, rating)).resolves.toEqual(expect.any(String));
  });
});

describe('one review per person per application', () => {
  it('refuses the second, so two concurrent submits cannot both land', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    await insertReview(applicationId, owner);

    expect(pgErrorCode(await rejection(insertReview(applicationId, owner)))).toBe(UNIQUE_VIOLATION);
  });

  it('lets the same person review a different application', async () => {
    const owner = await insertUser();
    const first = await insertApplication(owner);
    const second = await insertApplication(owner);
    await insertReview(first, owner);

    await expect(insertReview(second, owner)).resolves.toEqual(expect.any(String));
  });
});

describe('a review is about the program, not about the page', () => {
  it('survives the listing being withdrawn', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const listingId = await insertListing(applicationId);
    const reviewId = await insertReview(applicationId, owner);

    await getDb().delete(appListings).where(eq(appListings.id, listingId));

    const rows = await getDb().select().from(appReviews).where(eq(appReviews.id, reviewId));
    expect(rows).toHaveLength(1);
  });

  it('goes when the application does', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const reviewId = await insertReview(applicationId, owner);

    await getDb().delete(applications).where(eq(applications.id, applicationId));

    const rows = await getDb().select().from(appReviews).where(eq(appReviews.id, reviewId));
    expect(rows).toEqual([]);
  });
});

describe('the publisher answers once', () => {
  it('refuses a second reply to the same review', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const reviewId = await insertReview(applicationId, owner);
    await getDb().insert(appReviewReplies).values({ reviewId, authorUserId: owner, body: 'Thanks.' });

    expect(
      pgErrorCode(
        await rejection(
          getDb().insert(appReviewReplies).values({ reviewId, authorUserId: owner, body: 'Again.' })
        )
      )
    ).toBe(UNIQUE_VIOLATION);
  });

  it('keeps the answer when its author erases their account', async () => {
    const author = await insertUser();
    const reviewer = await insertUser();
    const applicationId = await insertApplication(reviewer);
    const reviewId = await insertReview(applicationId, reviewer);
    await getDb()
      .insert(appReviewReplies)
      .values({ reviewId, authorUserId: author, body: 'Thanks.' });

    await getDb().delete(users).where(eq(users.id, author));

    const [row] = await getDb()
      .select()
      .from(appReviewReplies)
      .where(eq(appReviewReplies.reviewId, reviewId));
    expect(row).toBeDefined();
    expect(row.authorUserId).toBeNull();
    expect(row.body).toBe('Thanks.');
  });

  it('goes with the review it answers', async () => {
    const owner = await insertUser();
    const applicationId = await insertApplication(owner);
    const reviewId = await insertReview(applicationId, owner);
    await getDb().insert(appReviewReplies).values({ reviewId, authorUserId: owner, body: 'Thanks.' });

    await getDb().delete(appReviews).where(eq(appReviews.id, reviewId));

    const rows = await getDb()
      .select()
      .from(appReviewReplies)
      .where(eq(appReviewReplies.reviewId, reviewId));
    expect(rows).toEqual([]);
  });
});
