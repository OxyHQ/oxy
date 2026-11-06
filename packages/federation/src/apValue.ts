/**
 * The ONE way to read an ActivityStreams value whose JSON-LD shape varies.
 *
 * JSON-LD lets the same statement arrive in several shapes, and every one of
 * them is valid ActivityPub:
 *
 *   - compaction turns a one-element array into the value itself, so `tag`,
 *     `attachment`, `alsoKnownAs`, `to` or `icon` may be one object or a list
 *     (GoToSocial sends single values; Mastodon sends arrays);
 *   - a reference may be the IRI string, an embedded object naming it by `id`,
 *     or a `Link` naming it by `href`;
 *   - an image may be a URL string, an `Image` whose `url` is a string, a `Link`
 *     or a list of them, or a list of `Image`s (PeerTube 6+ sends icon sizes);
 *   - a media type may carry parameters (`application/ld+json; profile="…"`),
 *     spaced or quoted however the server likes;
 *   - a date may use any ISO 8601 offset spelling (`Z`, `+00:00`, `+0000`, `+00`).
 *
 * A reader that assumes one shape loses the others SILENTLY: the mention, tag,
 * alias or avatar is simply not there, and nothing logs. These helpers accept
 * every shape, so readers never re-derive the rule. They are pure and
 * dependency-free (browser-safe).
 */

/**
 * A one-or-many ActivityStreams property as a list. A single value becomes a
 * one-element list, an absent (`undefined` / `null`) value an empty one, and the
 * `null` / `undefined` entries of a list are dropped.
 */
export function apList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [value];
  return value.filter((entry) => entry !== undefined && entry !== null);
}

/**
 * The IRI a JSON-LD node reference names: the string itself, the `id` of an
 * embedded object, or the `href` of a `Link` (a `Mention` tag, a `Link` `url`).
 * ActivityStreams lets a server embed a referenced node (an actor's `followers`
 * collection with its `totalItems`, an `endpoints` value) instead of linking it,
 * and all of these mean the same node. Anything else, a list included, names none;
 * read a list through {@link apIriList}.
 */
export function apIri(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { id, href } = value as { id?: unknown; href?: unknown };
    if (typeof id === 'string' && id) return id;
    if (typeof href === 'string' && href) return href;
  }
  return undefined;
}

/**
 * Every IRI a one-or-many reference property names (`to`, `cc`, `audience`,
 * `alsoKnownAs`, `attributedTo`), in order: {@link apList} read through
 * {@link apIri}, dropping the entries that name none.
 */
export function apIriList(value: unknown): string[] {
  const iris: string[] = [];
  for (const entry of apList(value)) {
    const iri = apIri(entry);
    if (iri) iris.push(iri);
  }
  return iris;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]/i.test(value);
}

/** Nesting a real image value needs: icon list → Image → url list → Link. */
const AP_IMAGE_MAX_DEPTH = 4;

/**
 * The first absolute http(s) URL an image-valued property (`icon`, `image`, an
 * `Image` attachment's `url`) names: a URL string, an object's `url` or `href`
 * (an `Image` whose `url` is a string, a `Link` or a list of them), or the
 * first entry of a list that names one.
 */
export function apImageUrl(value: unknown): string | undefined {
  return imageUrlAt(value, 0);
}

function imageUrlAt(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') return isAbsoluteHttpUrl(value) ? value : undefined;
  if (depth >= AP_IMAGE_MAX_DEPTH || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = imageUrlAt(entry, depth + 1);
      if (url) return url;
    }
    return undefined;
  }
  const record = value as { url?: unknown; href?: unknown };
  return imageUrlAt(record.url, depth + 1) ?? imageUrlAt(record.href, depth + 1);
}

/**
 * The base of a media type, lowercased and without parameters:
 * `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` and
 * `Application/LD+JSON;profile=…` are both `application/ld+json`. Empty for a
 * value that is not a string.
 */
export function apMediaTypeBase(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Whether a media type is an ActivityStreams document's (`application/activity+json`
 * or `application/ld+json`, with any parameters): what a WebFinger `self` link or
 * an actor response names.
 */
export function isActivityPubMediaType(value: unknown): boolean {
  const base = apMediaTypeBase(value);
  return base === 'application/activity+json' || base === 'application/ld+json';
}

const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * A date an ActivityStreams document asserts (`published`, `updated`, a field's
 * `verifiedAt`), parsed leniently, or `undefined` when it names no date.
 *
 * ISO 8601 is read in every offset spelling servers send (`Z`, `+00:00`, `+0000`,
 * `+00`), with a space for the `T`, a comma for the decimal point and a missing
 * offset (read as UTC), so the result does not depend on the JavaScript engine's
 * own `Date` parser. Another string is accepted when it names a four-digit year
 * and that parser reads it (an RFC 2822 date). A `Date` passes through when
 * valid. It never clamps: a caller that must bound future dates does so itself.
 */
export function apDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const iso = ISO_DATE_TIME.exec(text);
  if (iso) {
    const [, day, time = '00:00:00', offset = 'Z'] = iso;
    const parsed = new Date(`${day}T${time.replace(',', '.')}${isoOffset(offset)}`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (!/\b\d{4}\b/.test(text)) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isoOffset(offset: string): string {
  if (offset === 'Z' || offset === 'z') return 'Z';
  const digits = offset.slice(1).replace(':', '');
  return `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
}
