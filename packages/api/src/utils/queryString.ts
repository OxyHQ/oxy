/**
 * Read a query parameter that must be a single string.
 *
 * `qs` (Express's parser) turns a REPEATED parameter into an array and a nested
 * one into an object, so the idiomatic `typeof req.query.x === 'string' ? … :
 * undefined` reads both as ABSENT. For a parameter that NARROWS what is served
 * — `?variant=w96` asks for a 96px crop — "absent" is not a safe reading of
 * "supplied twice": it means the caller gets the unnarrowed thing.
 *
 * That is not hypothetical. Measured against production, `cloud.oxy.so/<id>
 * ?variant=w96&variant=w96` redirected to `/content/…`, the full-resolution
 * original, where a single `?variant=w96` redirects to `/variants/…`. The
 * response is a 302 either way, so nothing errors and nothing logs; the CDN
 * then caches the original as the answer for that URL. An avatar request can
 * come back several megabytes instead of a couple of kilobytes.
 *
 * The last value wins, which is how a repeated query parameter is conventionally
 * read and the only choice that keeps a duplicated parameter equivalent to
 * sending it once. A non-string element (a nested object) yields `undefined` —
 * there is no value there to honour.
 */
export function singleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const last = value[value.length - 1];
  return typeof last === 'string' ? last : undefined;
}
