/**
 * Link Preview (unfurl) Mixin
 *
 * Resolves link previews ("unfurls") through the Oxy API so every Oxy app
 * stops scraping link metadata locally. The API owns resolution and re-hosts
 * the preview `image`/`favicon` on Oxy media (`cloud.oxy.so/<fileId>`), so
 * consumers render the returned URLs directly with no per-app proxy.
 *
 * Wire shapes (`LinkPreview`, `LinkPreviewBatchResponse`) are the single source
 * of truth in `@oxy.so/contracts`; this mixin imports them rather than
 * redefining them so producer (oxy-api) and consumers cannot drift.
 *
 * Caching note: these GET/POST reads are NOT cached at the SDK layer (`cache:
 * false`). A preview can be returned `'pending'` first and `'resolved'` on a
 * later read, so an SDK GET cache would pin the stale `'pending'` snapshot.
 * App-side caching (React Query / stores) owns this responsibility.
 */
import type { LinkPreview } from '@oxy.so/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { buildUrl } from '../utils/apiUtils';

/**
 * Maximum number of URLs sent per `POST /links/previews` request. Matches the
 * server-side batch cap (`linkPreviewBatchRequestSchema`'s `.max(50)`); larger
 * inputs are split into multiple chunked calls and the result maps merged,
 * mirroring how `getUsersByIds` chunks at 100.
 */
const LINK_PREVIEWS_CHUNK_SIZE = 50;

export function OxyServicesLinksMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Resolve a single link preview via `GET /links/preview?url=<encoded>&wait=0|1`.
     *
     * @param url - The URL to unfurl. Sent percent-encoded in the query string.
     * @param opts.wait - When `true`, asks the server to resolve synchronously
     *   (`wait=1`) instead of returning a `'pending'` placeholder for a
     *   first-seen URL. Defaults to `false` (`wait=0`).
     *
     * Not cached at the SDK layer: a `'pending'` result can become `'resolved'`
     * on a later read, so caching here would serve the stale placeholder.
     */
    async getLinkPreview(url: string, opts?: { wait?: boolean }): Promise<LinkPreview> {
      try {
        const path = buildUrl('/links/preview', { url, wait: opts?.wait ? 1 : 0 });
        return await this.makeRequest<LinkPreview>('GET', path, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve multiple link previews via `POST /links/previews` (body `{ urls }`).
     *
     * Inputs are de-duplicated and split into chunks of {@link LINK_PREVIEWS_CHUNK_SIZE}
     * (the server-side cap). Chunks run concurrently and their result maps are
     * merged into a single result keyed by the REQUESTED url (the exact string
     * passed in `urls`) — matching the batch contract — so a caller can always
     * look its own input back up.
     *
     * `makeRequest` unwraps the API's top-level `{ data }` envelope (same as
     * `getUsersByIds`'s `makeServiceRequest<User[]>`), so each chunk response is
     * already the `Record<url, LinkPreview>` map — merge it directly.
     *
     * An empty / whitespace-only input resolves immediately with `{}` and
     * performs no network call. A failure in any chunk surfaces (via
     * `handleError`) rather than being swallowed.
     */
    async getLinkPreviews(urls: string[]): Promise<Record<string, LinkPreview>> {
      const uniqueUrls = Array.from(
        new Set(urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)),
      );
      if (uniqueUrls.length === 0) {
        return {};
      }

      const chunks: string[][] = [];
      for (let i = 0; i < uniqueUrls.length; i += LINK_PREVIEWS_CHUNK_SIZE) {
        chunks.push(uniqueUrls.slice(i, i + LINK_PREVIEWS_CHUNK_SIZE));
      }

      try {
        const responses = await Promise.all(
          chunks.map((chunk) =>
            this.makeRequest<Record<string, LinkPreview>>(
              'POST',
              '/links/previews',
              { urls: chunk },
              { cache: false },
            ),
          ),
        );

        return responses.reduce<Record<string, LinkPreview>>(
          (merged, response) => Object.assign(merged, response ?? {}),
          {},
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
