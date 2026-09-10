import type express from 'express';

/**
 * Send a redirect that a cache may hold and a media client may range.
 *
 * WHY THIS EXISTS. `res.redirect` ships a ~130-byte HTML courtesy page with the
 * 302, and our asset redirects are deliberately cacheable so the id→key lookup
 * is memoised at the edge. CloudFront then answers RANGED requests out of that
 * cached BODY, and a range past its length is unsatisfiable:
 *
 *   GET cloud.oxy.so/<id>  Range: bytes=1000000-
 *   → 416, content-range: bytes *\/130, x-cache: Error from cloudfront
 *
 * A video player asks for exactly that whenever it re-opens a source at a
 * non-zero offset — every seek, every resume. Measured on a Pixel 10 Pro: every
 * "Video unavailable" in Mention's reel was this 416 arriving as ExoPlayer's
 * `Source error`, on assets whose bytes were perfectly fine.
 *
 * So a redirect carries no body to slice and says that ranges do not apply to
 * it. The bytes get ranged at the target, where the range belongs.
 *
 * EVERY route that redirects to an asset URL must go through here. The defect is
 * per-call-site — `cdn.ts` was fixed first and `/assets/:id/stream` kept it —
 * and a shared emitter is what stops the next redirect from reintroducing it.
 *
 * The caller owns `Cache-Control`: these routes disagree about it on purpose
 * (a public CDN redirect is cached for an hour, a per-user download URL for a
 * private minute), and none of that changes the range question.
 */
export function sendAssetRedirect(res: express.Response, url: string): void {
  res.setHeader('Accept-Ranges', 'none');
  res.status(302).location(url).end();
}
