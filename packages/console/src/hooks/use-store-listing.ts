import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services';
import type {
  AddScreenshotInput,
  PublisherListing,
  StoreCategory,
  StoreScreenshot,
  UpdateScreenshotInput,
  WriteListingInput,
} from '@oxy.so/core';

// ===========================================================================
// The application's store listing.
//
// Unlike the Updates hooks next door, these go through `oxyServices.store`
// rather than `oxyServices.request`: the store HAS a namespace, and reaching past
// it would put URL strings and response-envelope knowledge in the Console —
// which is exactly the drift the SDK exists to prevent.
//
// Every write here needs `app:update`, which is what the API enforces; the
// caller gates the tab on it so a viewer never sees a form that would 403.
// Reading needs only `app:read`.
//
// A listing may legitimately NOT exist: an application that has never been
// listed has no page, and `store.listing.get` answers `null` rather than 404. The
// UI reads that null as "not listed yet", which is a different screen from an
// error.
// ===========================================================================

export type {
  PublisherListing,
  StoreCategory,
  StoreScreenshot,
  WriteListingInput,
  AddScreenshotInput,
  UpdateScreenshotInput,
};

const queryKeys = {
  listing: (appId: string) => ['store-listing', appId] as const,
  screenshots: (appId: string) => ['store-listing-screenshots', appId] as const,
  categories: ['store-categories'] as const,
};

// ===========================================================================
// Queries
// ===========================================================================

/** The application's store page in whatever state, or `null` if it has none. */
export function useStoreListing(appId: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.listing(appId),
    queryFn: () => oxyServices.store.listing.get(appId),
    enabled: isReady && isAuthenticated && !!appId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * The shelves a publisher can file their page under.
 *
 * Public and rarely edited, so it is cached for longer than the listing and is
 * not scoped to the application.
 */
export function useStoreCategories(enabled: boolean = true) {
  const { oxyServices, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: () => oxyServices.store.categories(),
    // No `isAuthenticated`: the storefront is readable before anyone signs in,
    // and the form needs the shelves whether or not the session is ready.
    enabled: isReady && enabled,
    staleTime: 1000 * 60 * 10,
    retry: 1,
  });
}

/** Every picture on the listing, in the author's order. */
export function useStoreScreenshots(appId: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.screenshots(appId),
    queryFn: () => oxyServices.store.listing.screenshots.list(appId),
    enabled: isReady && isAuthenticated && !!appId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

// ===========================================================================
// Mutations
//
// A write to the listing is written back into the cache rather than
// invalidated: the API answers with the row it just wrote, so refetching would
// ask for something already in hand. Screenshot writes DO invalidate, because
// adding, removing or reordering one changes the positions of the others.
// ===========================================================================

function useWriteListingCache(appId: string) {
  const queryClient = useQueryClient();
  return (listing: PublisherListing) => {
    queryClient.setQueryData(queryKeys.listing(appId), listing);
  };
}

/** Create the page, or replace its content. Never its status. */
export function useWriteStoreListing(appId: string) {
  const { oxyServices } = useAuth();
  const writeCache = useWriteListingCache(appId);

  return useMutation({
    mutationFn: (input: WriteListingInput) => oxyServices.store.listing.write(appId, input),
    onSuccess: writeCache,
  });
}

/** Hand the page to the store for review. */
export function useSubmitStoreListing(appId: string) {
  const { oxyServices } = useAuth();
  const writeCache = useWriteListingCache(appId);

  return useMutation({
    mutationFn: () => oxyServices.store.listing.submit(appId),
    onSuccess: writeCache,
  });
}

/** Take it down, or withdraw it from the queue. Back to a draft. */
export function useUnpublishStoreListing(appId: string) {
  const { oxyServices } = useAuth();
  const writeCache = useWriteListingCache(appId);

  return useMutation({
    mutationFn: () => oxyServices.store.listing.unpublish(appId),
    onSuccess: writeCache,
  });
}

function useInvalidateScreenshots(appId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.screenshots(appId) });
  };
}

/** Attach an already-uploaded image, appended to the end. */
export function useAddScreenshot(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateScreenshots(appId);

  return useMutation({
    mutationFn: (input: AddScreenshotInput) => oxyServices.store.listing.screenshots.add(appId, input),
    onSuccess: invalidate,
  });
}

/** Edit a picture's caption or the frame it was taken in. */
export function useUpdateScreenshot(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateScreenshots(appId);

  return useMutation({
    mutationFn: ({ screenshotId, ...input }: UpdateScreenshotInput & { screenshotId: string }) =>
      oxyServices.store.listing.screenshots.update(appId, screenshotId, input),
    onSuccess: invalidate,
  });
}

/** Remove a picture. The uploaded file stays. */
export function useDeleteScreenshot(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateScreenshots(appId);

  return useMutation({
    mutationFn: (screenshotId: string) =>
      oxyServices.store.listing.screenshots.delete(appId, screenshotId),
    onSuccess: invalidate,
  });
}

/**
 * Move a picture one place up or down.
 *
 * The API takes the WHOLE order, so this reads the list it was given, swaps a
 * neighbouring pair and sends every id back. Doing the swap here rather than
 * asking the server to "move item N" keeps the request a statement of what the
 * page should look like, which is the only shape that cannot half-apply.
 */
export function useReorderScreenshots(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateScreenshots(appId);

  return useMutation({
    mutationFn: (screenshotIds: Array<string>) =>
      oxyServices.store.listing.screenshots.reorder(appId, screenshotIds),
    onSuccess: invalidate,
  });
}

/** The ids of `screenshots` with the one at `index` moved one place in `direction`. */
export function moveScreenshot(
  screenshots: Array<StoreScreenshot>,
  index: number,
  direction: -1 | 1
): Array<string> {
  const target = index + direction;
  if (target < 0 || target >= screenshots.length) {
    return screenshots.map((shot) => shot.id);
  }
  const ids = screenshots.map((shot) => shot.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}
