/**
 * Who a subrequest to oxy-api is on behalf of.
 *
 * A Worker's `fetch` carries none of the visitor's headers unless it copies
 * them, so oxy-api saw every resolve this Worker made as ONE anonymous client
 * and charged all of them to one per-address bucket. On 2026-11-04 that bucket
 * ran dry and every avatar on mention.earth answered 429 until it rolled.
 *
 * The fix is Cloudflare's own, and needs no secret: on a SAME-ZONE subrequest,
 * Cloudflare sets `CF-Connecting-IP` (and, when the request carries none,
 * `X-Forwarded-For`) to the subrequest's `x-real-ip`
 * (https://developers.cloudflare.com/fundamentals/reference/http-headers/).
 * oxy-api already believes exactly one Cloudflare hop (`oxyTrustProxy`,
 * `@oxy.so/core/server`), so `req.ip` becomes the visitor by the same rule
 * that reads a browser's address, and every per-address limit applies per
 * visitor.
 *
 * Nobody else can use this to name an address: Cloudflare strips `x-real-ip`
 * from a visitor's own request, and a Worker on another zone is always reported
 * as one constant address. So `API_ORIGIN` must stay on this Worker's zone
 * (`api.oxy.so`, zone `oxy.so`); moved off it, the header is ignored and every
 * resolve is pooled again — bounded by oxy-api's `rl:cdn:`, never spoofable.
 *
 * `X-Forwarded-For` is deliberately never set: Cloudflare would append to it,
 * and the address oxy-api reads would be Cloudflare's view of this Worker
 * again.
 */
export function visitorHeaders(request: Request): Headers {
  const headers = new Headers();
  // Set by Cloudflare on the visitor's request to this Worker; a visitor
  // cannot write it.
  const visitor = request.headers.get('cf-connecting-ip');
  if (visitor) headers.set('x-real-ip', visitor);
  return headers;
}
