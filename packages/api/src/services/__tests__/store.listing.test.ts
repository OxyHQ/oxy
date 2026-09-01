/**
 * A listing's life: written by its publisher, published by the store.
 *
 * The transitions are the reason this runs against a real database. Each one
 * checks what the page is moving FROM, and the states it refuses are as
 * load-bearing as the ones it allows — a guard that let a rejected page be
 * published by replaying a request would pass any test that only asserted the
 * happy path.
 *
 * The two rules easiest to break by accident are covered explicitly: editing a
 * live page must not unpublish it, and a page taken down and put back up keeps
 * its ORIGINAL publication date.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCategories } from '../../db/schema/appCategories';
import { appListings } from '../../db/schema/appListings';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/error';
import {
  approveListing,
  createCategory,
  deleteCategory,
  getListingForApplication,
  getPublishedListing,
  listCategories,
  listListingsAwaitingReview,
  rejectListing,
  submitListing,
  unpublishListing,
  updateCategory,
  upsertListing,
} from '../store.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An application with no listing, which is where every publisher starts. */
async function unlistedApp(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb()
    .insert(users)
    .values({ username: `pub-${suffix}`, email: `pub-${suffix}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `App ${suffix}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  return application.id;
}

function freshSlug(): string {
  return `slug-${randomUUID().slice(0, 8)}`;
}

/** A page all the way to `published`, which several cases need as a starting point. */
async function publishedListing(): Promise<{ applicationId: string; slug: string }> {
  const applicationId = await unlistedApp();
  const slug = freshSlug();
  await upsertListing({ applicationId, slug, tagline: 'One line' });
  await submitListing(applicationId);
  await approveListing(applicationId);
  return { applicationId, slug };
}

describe('writing the page', () => {
  it('creates it as a draft — publishing is not the publisher’s to do', async () => {
    const applicationId = await unlistedApp();

    const listing = await upsertListing({
      applicationId,
      slug: freshSlug(),
      tagline: 'Does one thing',
      description: '# About\n\nAt length.',
    });

    expect(listing.status).toBe('draft');
    expect(listing.publishedAt).toBeNull();
    expect(listing.tagline).toBe('Does one thing');
  });

  it('files it on a shelf by slug, and answers with the shelf’s label', async () => {
    const applicationId = await unlistedApp();
    const categorySlug = `cat-${randomUUID().slice(0, 8)}`;
    await getDb().insert(appCategories).values({ slug: categorySlug, label: 'Productivity' });

    const listing = await upsertListing({ applicationId, slug: freshSlug(), categorySlug });

    expect(listing.category).toEqual({ slug: categorySlug, label: 'Productivity' });
  });

  it('names a shelf that does not exist rather than filing it nowhere', async () => {
    const applicationId = await unlistedApp();

    await expect(
      upsertListing({ applicationId, slug: freshSlug(), categorySlug: `nope-${randomUUID()}` })
    ).rejects.toThrow(BadRequestError);
  });

  it('replaces the one listing rather than adding a second', async () => {
    const applicationId = await unlistedApp();
    const first = await upsertListing({ applicationId, slug: freshSlug(), tagline: 'Before' });

    const second = await upsertListing({ applicationId, slug: freshSlug(), tagline: 'After' });

    expect(second.id).toBe(first.id);
    expect(second.tagline).toBe('After');
    const stored = await getDb()
      .select()
      .from(appListings)
      .where(eq(appListings.applicationId, applicationId));
    expect(stored).toHaveLength(1);
  });

  it('refuses a slug another app already holds, and says which', async () => {
    const taken = freshSlug();
    await upsertListing({ applicationId: await unlistedApp(), slug: taken });

    await expect(upsertListing({ applicationId: await unlistedApp(), slug: taken })).rejects.toThrow(
      ConflictError
    );
  });

  it('does NOT unpublish a live page when its words are corrected', async () => {
    const { applicationId, slug } = await publishedListing();

    const edited = await upsertListing({ applicationId, slug, tagline: 'Corrected' });

    expect(edited.status).toBe('published');
    expect(await getPublishedListing(slug)).not.toBeNull();
  });
});

describe('handing the page in', () => {
  it('takes a draft into the queue', async () => {
    const applicationId = await unlistedApp();
    await upsertListing({ applicationId, slug: freshSlug() });

    expect((await submitListing(applicationId)).status).toBe('pending_review');
  });

  it('takes a rejected page back into the queue once it is fixed', async () => {
    const applicationId = await unlistedApp();
    await upsertListing({ applicationId, slug: freshSlug() });
    await submitListing(applicationId);
    await rejectListing(applicationId);

    expect((await submitListing(applicationId)).status).toBe('pending_review');
  });

  it('refuses to re-submit a page that is already live', async () => {
    const { applicationId } = await publishedListing();

    await expect(submitListing(applicationId)).rejects.toThrow(ConflictError);
  });

  it('says so when there is no page to submit', async () => {
    await expect(submitListing(await unlistedApp())).rejects.toThrow(NotFoundError);
  });
});

describe('the store’s decision', () => {
  it('publishes a page that was submitted, and stamps when', async () => {
    const applicationId = await unlistedApp();
    const slug = freshSlug();
    await upsertListing({ applicationId, slug });
    await submitListing(applicationId);

    const approved = await approveListing(applicationId);

    expect(approved.status).toBe('published');
    expect(approved.publishedAt).toBeInstanceOf(Date);
    expect(await getPublishedListing(slug)).toMatchObject({ slug });
  });

  it('will not publish a draft that was never submitted', async () => {
    const applicationId = await unlistedApp();
    await upsertListing({ applicationId, slug: freshSlug() });

    await expect(approveListing(applicationId)).rejects.toThrow(ConflictError);
  });

  it('will not approve the same submission twice', async () => {
    const { applicationId } = await publishedListing();

    await expect(approveListing(applicationId)).rejects.toThrow(ConflictError);
  });

  it('sends a page back, and the storefront stops serving it', async () => {
    const applicationId = await unlistedApp();
    const slug = freshSlug();
    await upsertListing({ applicationId, slug });
    await submitListing(applicationId);

    expect((await rejectListing(applicationId)).status).toBe('rejected');
    expect(await getPublishedListing(slug)).toBeNull();
  });

  it('lists what is waiting, and nothing that is not', async () => {
    const waiting = await unlistedApp();
    await upsertListing({ applicationId: waiting, slug: freshSlug() });
    await submitListing(waiting);
    const drafting = await unlistedApp();
    await upsertListing({ applicationId: drafting, slug: freshSlug() });

    const { items } = await listListingsAwaitingReview({ limit: 100, offset: 0 });
    const queued = items.map((item) => item.applicationId);

    expect(queued).toContain(waiting);
    expect(queued).not.toContain(drafting);
    expect(items.every((item) => item.status === 'pending_review')).toBe(true);
  });
});

describe('taking a page down', () => {
  it('returns it to a draft rather than deleting the publisher’s work', async () => {
    const { applicationId, slug } = await publishedListing();

    const down = await unpublishListing(applicationId);

    expect(down.status).toBe('draft');
    expect(down.slug).toBe(slug);
    expect(down.tagline).toBe('One line');
    expect(await getPublishedListing(slug)).toBeNull();
  });

  it('withdraws a submission from the queue', async () => {
    const applicationId = await unlistedApp();
    await upsertListing({ applicationId, slug: freshSlug() });
    await submitListing(applicationId);

    expect((await unpublishListing(applicationId)).status).toBe('draft');
  });

  it('keeps the ORIGINAL publication date when a page goes back up', async () => {
    const { applicationId } = await publishedListing();
    const firstPublishedAt = (await getListingForApplication(applicationId))!.publishedAt;

    await unpublishListing(applicationId);
    await submitListing(applicationId);
    const republished = await approveListing(applicationId);

    // A page has one publication date and many edits, which is the whole
    // reason `published_at` is its own column rather than read off `updated_at`.
    expect(republished.publishedAt).toEqual(firstPublishedAt);
  });

  it('refuses to take down a page that is already a draft', async () => {
    const applicationId = await unlistedApp();
    await upsertListing({ applicationId, slug: freshSlug() });

    await expect(unpublishListing(applicationId)).rejects.toThrow(ConflictError);
  });
});

describe('curating the shelves', () => {
  it('adds one, and the storefront lists it in the curated order', async () => {
    const prefix = randomUUID().slice(0, 8);
    await createCategory({ slug: `${prefix}-late`, label: 'Late', order: 9000 });
    await createCategory({ slug: `${prefix}-early`, label: 'Early', order: 8000 });

    const ours = (await listCategories()).filter((row) => row.slug.startsWith(prefix));

    expect(ours.map((row) => row.label)).toEqual(['Early', 'Late']);
  });

  it('refuses a slug that is taken', async () => {
    const slug = `cat-${randomUUID().slice(0, 8)}`;
    await createCategory({ slug, label: 'First' });

    await expect(createCategory({ slug, label: 'Second' })).rejects.toThrow(ConflictError);
  });

  it('renames and reorders without touching the slug', async () => {
    const slug = `cat-${randomUUID().slice(0, 8)}`;
    await createCategory({ slug, label: 'Housing', description: 'Homes', order: 10 });

    const updated = await updateCategory(slug, { label: 'Homes', order: 15 });

    expect(updated).toMatchObject({ slug, label: 'Homes', order: 15 });
    // Untouched, because the patch did not name it.
    expect(updated.description).toBe('Homes');
  });

  it('says so when there is no such shelf', async () => {
    await expect(updateCategory(`missing-${randomUUID()}`, { label: 'x' })).rejects.toThrow(
      NotFoundError
    );
    await expect(deleteCategory(`missing-${randomUUID()}`)).rejects.toThrow(NotFoundError);
  });

  it('retiring a shelf uncategorises its listings rather than deleting them', async () => {
    const slug = `cat-${randomUUID().slice(0, 8)}`;
    await createCategory({ slug, label: 'Doomed' });
    const applicationId = await unlistedApp();
    const listingSlug = freshSlug();
    await upsertListing({ applicationId, slug: listingSlug, categorySlug: slug, tagline: 'Alive' });
    await submitListing(applicationId);
    await approveListing(applicationId);

    const { listingsUncategorised } = await deleteCategory(slug);

    expect(listingsUncategorised).toBe(1);
    // The page is still published and still says what it said — only its shelf
    // is gone. `CASCADE` here would have deleted somebody's listing because a
    // curator tidied the taxonomy.
    const page = await getPublishedListing(listingSlug);
    expect(page).toMatchObject({ slug: listingSlug, tagline: 'Alive', category: null });
  });
});
