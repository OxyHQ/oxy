/**
 * App Store Methods Mixin
 *
 * The client surface for the Oxy app store: the public storefront (`/store`),
 * the reviews people write there, and the listing a publisher edits for an
 * application they own (`/applications/:appId/listing`).
 *
 * Deliberately separate from `OxyServices.accounts.ts` even though the
 * publisher's routes hang off an application, for the same reason
 * `OxyServices.connectedApps.ts` is: those mixins answer "may this program act
 * for this person?", and this one answers "should this person choose it?". Turn
 * the store off and OAuth still works — which is the test that says the store is
 * a module over the platform rather than part of it.
 *
 * The two prefixes are one domain. A listing IS the store's page for an
 * application, so both halves of its life belong to the same surface; the API
 * puts the publisher's half beside credentials and webhooks because that is
 * where the permission that guards it already lives, and reusing that permission
 * is what stops a store page becoming a second, weaker way to act for somebody's
 * app.
 *
 * ## What is NOT duplicated here
 *
 * A listing carries no name, icon or legal links: `applications` already holds
 * them and the storefront joins them in. A rating is computed from the visible
 * reviews on every read rather than stored, so a hidden review stops counting
 * the moment it is hidden. Reference listings by their `slug` in the storefront
 * (it is what every link carries) and applications by their `_id` in the
 * publisher's calls.
 */
import type { OxyServicesBase } from '../OxyServices.base';
import { CACHE_TIMES } from './mixinHelpers';

/** A shelf on the storefront. */
export interface StoreCategory {
  /** The public identifier a link carries. Never the row id. */
  slug: string;
  /** What a person reads. Never derived from the slug at render time. */
  label: string;
  description?: string | null;
}

/** The rating of an app, computed from its visible reviews. */
export interface StoreRating {
  /** Rounded to one decimal, or `null` when nobody has reviewed it — never 0. */
  average: number | null;
  count: number;
}

/** An app as a card on the storefront: what a listing page needs, and no more. */
export interface StoreListingSummary {
  slug: string;
  /** From the APPLICATION, joined in — the listing keeps no copy. */
  name: string;
  tagline: string | null;
  /** A file id for the app's icon, resolved through the usual image resolver. */
  icon: string | null;
  category: StoreCategory | null;
  rating: StoreRating;
}

/** A store page in full. */
export interface StoreListingDetail extends StoreListingSummary {
  description: string | null;
  /** These four come from the application; the consent screen shows the same values. */
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  publishedAt: string | null;
  screenshots: StoreScreenshot[];
  /** How many visible reviews gave each of 1..5. Absent keys are zero. */
  ratingBreakdown: Record<number, number>;
}

/** Which frame a screenshot was taken in. The store groups by it on the page. */
export type StoreScreenshotPlatform = 'phone' | 'tablet' | 'desktop' | 'web';

export interface StoreScreenshot {
  id: string;
  /** The uploaded asset's file id. Upload through the assets surface first. */
  fileId: string;
  platform: StoreScreenshotPlatform;
  caption: string | null;
  position: number;
}

/** Somebody's review, as it appears on a store page. */
export interface StoreReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: string;
  author: { id: string; username: string | null };
  /** The publisher's answer, when there is one. */
  reply: { body: string; createdAt: string } | null;
  /**
   * Whether this author has authorized the application, read from their grant
   * at request time rather than stored on the review.
   *
   * It is not a claim that they still use it, and it is `false` for a
   * first-party app nobody has to consent to — so render its absence as nothing
   * at all rather than as a demotion.
   */
  authorUsesApp: boolean;
}

/** A review as its own author sees it, whatever its moderation state. */
export interface StoreOwnReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** An author is told when their review is hidden; the public list is not. */
  status: 'visible' | 'hidden' | 'flagged' | 'removed';
  createdAt: string;
  updatedAt: string;
}

/** What a person submits about an app. One review each; writing again replaces it. */
export interface WriteStoreReviewInput {
  /** Whole stars, 1 to 5. The database enforces the bound too. */
  rating: number;
  title?: string | null;
  body?: string | null;
}

/** Where a listing is in its life. `pending_review` is the STORE's review of the page. */
export type StoreListingStatus = 'draft' | 'pending_review' | 'published' | 'rejected';

/** A listing as its publisher sees it: whatever state it is in. */
export interface PublisherListing {
  id: string;
  applicationId: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  category: StoreCategory | null;
  supportUrl: string | null;
  supportEmail: string | null;
  status: StoreListingStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The whole page, not a patch: sending everything is what makes "clear the
 * tagline" expressible at all.
 *
 * `status` is absent on purpose. Publishing is the store's decision and has its
 * own calls, so a publisher cannot publish themselves by putting a field in a
 * body.
 */
export interface WriteListingInput {
  /** Lowercase letters, digits and single hyphens. What every link carries. */
  slug: string;
  tagline?: string | null;
  description?: string | null;
  /** A category SLUG, never its id. */
  categorySlug?: string | null;
  supportUrl?: string | null;
  supportEmail?: string | null;
}

export interface AddScreenshotInput {
  /** An already-uploaded image. Must be live, an image, and yours to publish. */
  fileId: string;
  platform?: StoreScreenshotPlatform;
  caption?: string | null;
}

export interface UpdateScreenshotInput {
  platform?: StoreScreenshotPlatform;
  caption?: string | null;
}

/**
 * One page of a paginated store read.
 *
 * `hasMore` comes from the API rather than being derived here, so a caller that
 * pages does not have to re-implement the boundary the server already computed.
 */
export interface StorePage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** Options for paging the storefront and the reviews under an app. */
export interface StorePageOptions {
  limit?: number;
  offset?: number;
}

export interface StoreReviewsOptions extends StorePageOptions {
  /** Newest first by default; `rating` surfaces the strongest opinions. */
  sort?: 'recent' | 'rating';
}

/**
 * The API's paginated envelope. The counts live under `pagination`, NOT under
 * `meta` — `meta` is what the single-object `sendSuccess` helper uses, and
 * reading the wrong one yields a `total` of zero on every page with no error
 * anywhere.
 */
interface PaginatedResponse<T> {
  data?: T[];
  pagination?: { total?: number; hasMore?: boolean };
}

/** Read one page out of that envelope. */
function pageOf<T>(res: PaginatedResponse<T>): StorePage<T> {
  return {
    items: res.data ?? [],
    total: res.pagination?.total ?? 0,
    hasMore: res.pagination?.hasMore ?? false,
  };
}

/**
 * Build a query string from the options that were actually supplied.
 *
 * Generic over the options object rather than taking a `Record`: an interface
 * has no implicit index signature in TypeScript, so `StoreReviewsOptions` would
 * not be assignable to one and every call site would need a cast.
 */
function queryOf<T extends object>(params: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export function OxyServicesStoreMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    // =========================================================================
    // The storefront — /store. No authentication: everything served is public.
    // =========================================================================

    /** The shelves, in the order the store curates them. */
    async listStoreCategories(): Promise<StoreCategory[]> {
      try {
        const res = await this.makeRequest<{ data: StoreCategory[] }>(
          'GET',
          '/store/categories',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.data ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Published listings, newest first, optionally one shelf.
     *
     * An unknown category slug is an EMPTY shelf, not every app on the store —
     * so a typo shows nothing rather than showing everything.
     *
     * @param options - `category` is a category slug; `limit` defaults to 24.
     */
    async listStoreApps(
      options: StorePageOptions & { category?: string } = {},
    ): Promise<StorePage<StoreListingSummary>> {
      try {
        const res = await this.makeRequest<PaginatedResponse<StoreListingSummary>>(
          'GET',
          `/store/apps${queryOf(options)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return pageOf(res);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * One store page.
     *
     * A draft answers 404 exactly as an unknown slug does: whether an
     * unpublished page exists under a name is not something a visitor learns.
     *
     * @param slug - The listing's public slug, not an application id.
     */
    async getStoreApp(slug: string): Promise<StoreListingDetail> {
      try {
        const res = await this.makeRequest<{ data: StoreListingDetail }>(
          'GET',
          `/store/apps/${encodeURIComponent(slug)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Visible reviews for a published app, each with the publisher's reply. */
    async listStoreReviews(
      slug: string,
      options: StoreReviewsOptions = {},
    ): Promise<StorePage<StoreReview>> {
      try {
        const res = await this.makeRequest<PaginatedResponse<StoreReview>>(
          'GET',
          `/store/apps/${encodeURIComponent(slug)}/reviews${queryOf(options)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return pageOf(res);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Reviewing — any signed-in Oxy account
    // =========================================================================

    /** The caller's own review of an app, or `null` if they have not written one. */
    async getMyStoreReview(slug: string): Promise<StoreOwnReview | null> {
      try {
        const res = await this.makeRequest<{ data: StoreOwnReview | null }>(
          'GET',
          `/store/apps/${encodeURIComponent(slug)}/review`,
          undefined,
          { cache: false },
        );
        return res.data ?? null;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Write the caller's review, or replace what they said before.
     *
     * A person has one review per app, so this sets it rather than adding one.
     * Rewriting does not clear a moderator's decision: a hidden review stays
     * hidden when its author edits it.
     */
    async writeStoreReview(slug: string, input: WriteStoreReviewInput): Promise<StoreOwnReview> {
      try {
        const res = await this.makeRequest<{ data: StoreOwnReview }>(
          'PUT',
          `/store/apps/${encodeURIComponent(slug)}/review`,
          input,
          { cache: false },
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Withdraw the caller's own review. A real delete — the words were theirs. */
    async deleteMyStoreReview(slug: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/store/apps/${encodeURIComponent(slug)}/review`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Answer a review on the publisher's behalf.
     *
     * Requires `app:update` over the application's owning account — the same
     * permission that guards every other write to that application. Addressed
     * by review id because the reply belongs to the review, and a listing can be
     * renamed or withdrawn out from under it.
     */
    async replyToStoreReview(reviewId: string, body: string): Promise<{ id: string; reviewId: string; body: string }> {
      try {
        const res = await this.makeRequest<{ data: { id: string; reviewId: string; body: string } }>(
          'PUT',
          `/store/reviews/${encodeURIComponent(reviewId)}/reply`,
          { body },
          { cache: false },
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Withdraw the publisher's answer. Same permission that wrote it. */
    async deleteStoreReviewReply(reviewId: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/store/reviews/${encodeURIComponent(reviewId)}/reply`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // The publisher's listing — /applications/:appId/listing
    // =========================================================================

    /** The application's store page in whatever state, or `null` if it has none. */
    async getAppListing(applicationId: string): Promise<PublisherListing | null> {
      try {
        return await this.makeRequest<PublisherListing | null>(
          'GET',
          `/applications/${encodeURIComponent(applicationId)}/listing`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create the page or replace its content. Never its status.
     *
     * Editing does not move a page: correcting a typo on a live listing leaves
     * it live, and fixing a rejected one does not re-submit it.
     */
    async writeAppListing(applicationId: string, input: WriteListingInput): Promise<PublisherListing> {
      try {
        return await this.makeRequest<PublisherListing>(
          'PUT',
          `/applications/${encodeURIComponent(applicationId)}/listing`,
          input,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Hand the page to the store for review. From a draft, or a rejected page once fixed. */
    async submitAppListing(applicationId: string): Promise<PublisherListing> {
      try {
        return await this.makeRequest<PublisherListing>(
          'POST',
          `/applications/${encodeURIComponent(applicationId)}/listing/submit`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Take the page down, or withdraw it from the queue.
     *
     * Back to a draft, never deleted: the slug, the words and the screenshots
     * are the publisher's work, and the reviews were never the listing's to take
     * with them.
     */
    async unpublishAppListing(applicationId: string): Promise<PublisherListing> {
      try {
        return await this.makeRequest<PublisherListing>(
          'POST',
          `/applications/${encodeURIComponent(applicationId)}/listing/unpublish`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Screenshots
    // =========================================================================

    /** Every picture on the listing, in the author's order. */
    async listAppListingScreenshots(applicationId: string): Promise<StoreScreenshot[]> {
      try {
        return await this.makeRequest<StoreScreenshot[]>(
          'GET',
          `/applications/${encodeURIComponent(applicationId)}/listing/screenshots`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Attach an already-uploaded image, appended to the end.
     *
     * Upload through the assets surface first; the store keeps a reference
     * rather than a second copy of the asset pipeline. The file must be live, an
     * image, and one the caller is entitled to.
     */
    async addAppListingScreenshot(
      applicationId: string,
      input: AddScreenshotInput,
    ): Promise<StoreScreenshot> {
      try {
        return await this.makeRequest<StoreScreenshot>(
          'POST',
          `/applications/${encodeURIComponent(applicationId)}/listing/screenshots`,
          input,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Edit a picture's caption or the frame it was taken in. Order is {@link reorderAppListingScreenshots}. */
    async updateAppListingScreenshot(
      applicationId: string,
      screenshotId: string,
      input: UpdateScreenshotInput,
    ): Promise<StoreScreenshot> {
      try {
        return await this.makeRequest<StoreScreenshot>(
          'PATCH',
          `/applications/${encodeURIComponent(applicationId)}/listing/screenshots/${encodeURIComponent(screenshotId)}`,
          input,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Remove a picture. The uploaded file stays — it may be in use elsewhere. */
    async deleteAppListingScreenshot(applicationId: string, screenshotId: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/applications/${encodeURIComponent(applicationId)}/listing/screenshots/${encodeURIComponent(screenshotId)}`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Set the order of every picture at once.
     *
     * Send EVERY id on the listing, exactly once, in the order they should
     * appear. A partial list is rejected rather than applied: it would leave the
     * pictures it omits at their old positions, interleaved with the new ones.
     */
    async reorderAppListingScreenshots(
      applicationId: string,
      screenshotIds: string[],
    ): Promise<StoreScreenshot[]> {
      try {
        return await this.makeRequest<StoreScreenshot[]>(
          'PUT',
          `/applications/${encodeURIComponent(applicationId)}/listing/screenshots/order`,
          { screenshotIds },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
