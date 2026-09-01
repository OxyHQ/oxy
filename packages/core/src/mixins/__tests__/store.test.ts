/**
 * App Store Mixin Tests
 *
 * `makeRequest` is stubbed, so what these cover is the seam between this client
 * and the API: the method, the URL, whether a value is URL-encoded, whether a
 * read is cached, and — the part worth the most here — which envelope a
 * response is unwrapped from.
 *
 * The API has two of those and they are not interchangeable. A single object
 * comes back under `data`; a page comes back under `data` with its counts under
 * `pagination`. Reading `meta` instead, which is the plausible mistake, yields
 * `total: 0` on every page with no error anywhere and no type complaint — so it
 * is asserted against a fixture that has a non-zero total rather than trusted.
 *
 * The publisher's listing routes answer with the object itself, no envelope at
 * all, which is a third shape and is asserted separately for the same reason.
 */

import { OxyServices } from '../../OxyServices';
import type {
  PublisherListing,
  StoreCategory,
  StoreListingDetail,
  StoreListingSummary,
  StoreOwnReview,
  StoreReview,
  StoreScreenshot,
} from '../OxyServices.store';

const categoryFixture: StoreCategory = {
  slug: 'productivity',
  label: 'Productivity',
  description: 'Get things done',
};

const summaryFixture: StoreListingSummary = {
  slug: 'mention',
  name: 'Mention',
  tagline: 'The fediverse, at home',
  icon: 'file-1',
  category: categoryFixture,
  rating: { average: 4.6, count: 31 },
};

const detailFixture: StoreListingDetail = {
  ...summaryFixture,
  description: '# Mention',
  websiteUrl: 'https://mention.earth',
  privacyPolicyUrl: null,
  termsUrl: null,
  supportUrl: null,
  supportEmail: null,
  publishedAt: '2026-08-01T00:00:00.000Z',
  screenshots: [],
  ratingBreakdown: { 4: 10, 5: 21 },
};

const reviewFixture: StoreReview = {
  id: 'r1',
  rating: 5,
  title: null,
  body: 'Good',
  createdAt: '2026-08-01T00:00:00.000Z',
  author: { id: 'u1', username: 'nate' },
  reply: null,
  authorUsesApp: true,
};

const ownReviewFixture: StoreOwnReview = {
  id: 'r1',
  rating: 5,
  title: null,
  body: 'Good',
  status: 'visible',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const listingFixture: PublisherListing = {
  id: 'l1',
  applicationId: 'app1',
  slug: 'mention',
  tagline: 'The fediverse, at home',
  description: null,
  category: categoryFixture,
  supportUrl: null,
  supportEmail: null,
  status: 'draft',
  publishedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const screenshotFixture: StoreScreenshot = {
  id: 's1',
  fileId: 'file-9',
  platform: 'desktop',
  caption: null,
  position: 0,
};

describe('OxyServicesStoreMixin', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.httpService.setTokens('test-token');
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
  });

  describe('the storefront', () => {
    it('unwraps the shelves from `data` and caches the read', async () => {
      makeRequestSpy.mockResolvedValue({ data: [categoryFixture] });

      expect(await oxy.listStoreCategories()).toEqual([categoryFixture]);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/store/categories',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('reads a page count from `pagination`, not from `meta`', async () => {
      makeRequestSpy.mockResolvedValue({
        data: [summaryFixture],
        pagination: { total: 42, limit: 24, offset: 0, hasMore: true },
      });

      const page = await oxy.listStoreApps();

      // The fixture's total is deliberately not the length of `data`, and not
      // zero: reading the wrong envelope key would give 0 and reading `length`
      // would give 1, so only the right one gives 42.
      expect(page).toEqual({ items: [summaryFixture], total: 42, hasMore: true });
    });

    it('sends only the options that were supplied', async () => {
      makeRequestSpy.mockResolvedValue({ data: [], pagination: { total: 0 } });

      await oxy.listStoreApps();
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/store/apps');

      // An absent option must not travel as `undefined`, which is what a naive
      // template string produces and what the server would then have to reject.
      await oxy.listStoreApps({ category: 'productivity', limit: 12 });
      expect(makeRequestSpy.mock.calls[1][1]).toBe('/store/apps?category=productivity&limit=12');
    });

    it('survives a response with neither key', async () => {
      makeRequestSpy.mockResolvedValue({});
      expect(await oxy.listStoreApps()).toEqual({ items: [], total: 0, hasMore: false });
    });

    it('URL-encodes a slug in the path', async () => {
      makeRequestSpy.mockResolvedValue({ data: detailFixture });

      expect(await oxy.getStoreApp('a b/c')).toEqual(detailFixture);
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/store/apps/a%20b%2Fc');
    });

    it('pages reviews, and passes the sort through', async () => {
      makeRequestSpy.mockResolvedValue({
        data: [reviewFixture],
        pagination: { total: 3, hasMore: false },
      });

      const page = await oxy.listStoreReviews('mention', { sort: 'rating', limit: 5 });

      expect(page.total).toBe(3);
      expect(page.items[0].authorUsesApp).toBe(true);

      // Parsed rather than compared as a string: the parameter ORDER follows
      // whatever order the caller wrote their options object in, and pinning
      // that would make the test fail on a harmless edit at the call site.
      const [path, query] = String(makeRequestSpy.mock.calls[0][1]).split('?');
      expect(path).toBe('/store/apps/mention/reviews');
      expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
        sort: 'rating',
        limit: '5',
      });
    });
  });

  describe('reviewing', () => {
    it('answers null when the caller has not written one', async () => {
      makeRequestSpy.mockResolvedValue({ data: null });
      expect(await oxy.getMyStoreReview('mention')).toBeNull();
    });

    it('PUTs the review — one per person, so it sets rather than adds', async () => {
      makeRequestSpy.mockResolvedValue({ data: ownReviewFixture });

      expect(await oxy.writeStoreReview('mention', { rating: 5, body: 'Good' })).toEqual(
        ownReviewFixture,
      );
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'PUT',
        '/store/apps/mention/review',
        { rating: 5, body: 'Good' },
        expect.objectContaining({ cache: false }),
      );
    });

    it('withdraws the caller’s own review', async () => {
      makeRequestSpy.mockResolvedValue(undefined);

      await oxy.deleteMyStoreReview('mention');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/store/apps/mention/review',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    it('addresses a reply by review id, not by the listing’s slug', async () => {
      makeRequestSpy.mockResolvedValue({ data: { id: 'p1', reviewId: 'r1', body: 'Fixed' } });

      await oxy.replyToStoreReview('r1', 'Fixed');
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/store/reviews/r1/reply');
    });
  });

  describe('the publisher’s listing', () => {
    it('takes the object straight — these routes carry no envelope', async () => {
      makeRequestSpy.mockResolvedValue(listingFixture);

      expect(await oxy.getAppListing('app1')).toEqual(listingFixture);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/applications/app1/listing',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    it('PUTs the whole page, without a status field', async () => {
      makeRequestSpy.mockResolvedValue(listingFixture);

      await oxy.writeAppListing('app1', { slug: 'mention', tagline: 'Hello' });

      const body = makeRequestSpy.mock.calls[0][2];
      expect(body).toEqual({ slug: 'mention', tagline: 'Hello' });
      expect(body).not.toHaveProperty('status');
    });

    it('submits and unpublishes through their own routes', async () => {
      makeRequestSpy.mockResolvedValue(listingFixture);

      await oxy.submitAppListing('app1');
      expect(makeRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
        'POST',
        '/applications/app1/listing/submit',
      ]);

      await oxy.unpublishAppListing('app1');
      expect(makeRequestSpy.mock.calls[1].slice(0, 2)).toEqual([
        'POST',
        '/applications/app1/listing/unpublish',
      ]);
    });

    it('URL-encodes the application id', async () => {
      makeRequestSpy.mockResolvedValue(listingFixture);
      await oxy.getAppListing('a b/c');
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/applications/a%20b%2Fc/listing');
    });
  });

  describe('screenshots', () => {
    it('attaches an uploaded file', async () => {
      makeRequestSpy.mockResolvedValue(screenshotFixture);

      await oxy.addAppListingScreenshot('app1', { fileId: 'file-9', platform: 'phone' });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/applications/app1/listing/screenshots',
        { fileId: 'file-9', platform: 'phone' },
        expect.objectContaining({ cache: false }),
      );
    });

    it('encodes both ids on an edit', async () => {
      makeRequestSpy.mockResolvedValue(screenshotFixture);

      await oxy.updateAppListingScreenshot('a b', 's/1', { caption: 'Home' });
      expect(makeRequestSpy.mock.calls[0][1]).toBe('/applications/a%20b/listing/screenshots/s%2F1');
    });

    it('reorders by sending every id, on its own route', async () => {
      makeRequestSpy.mockResolvedValue([screenshotFixture]);

      await oxy.reorderAppListingScreenshots('app1', ['s2', 's1']);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'PUT',
        '/applications/app1/listing/screenshots/order',
        { screenshotIds: ['s2', 's1'] },
        expect.objectContaining({ cache: false }),
      );
    });
  });
});
