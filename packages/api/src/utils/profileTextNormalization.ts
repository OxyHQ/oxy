/**
 * Whitespace normalization for the STRUCTURED profile fields — `name`,
 * `linksMetadata`, `locations`, `links`.
 *
 * WHY THESE NEED THEIR OWN PASS
 * -----------------------------
 * `sanitizeProfileUpdate` only walks the TOP-LEVEL string values of a profile
 * update (`bio`, `description`, `address`, …) and deliberately skips these three
 * because they are arrays of structured objects, not free text. The result was
 * that the only profile fields carrying THIRD-PARTY text — the `<title>` /
 * `og:description` of a scraped remote page (`linksMetadata`) and the
 * Nominatim `display_name` of a geocoded place (`locations`) — were the only
 * ones stored exactly as the remote source wrote them.
 *
 * A remote page that serves
 *
 *     <title>
 *       Mi título
 *     </title>
 *
 * put a real newline plus six spaces of indentation into `linksMetadata[].title`,
 * and clients render that in a React Native `Text` (`white-space: pre-wrap` on
 * web), which does NOT collapse whitespace the way HTML does — so the profile
 * showed a blank line and an indent inside the link card.
 *
 * Every value normalized here is a ONE-LINE display value (a card title, a place
 * name, a URL), so they all go through the canonical `normalizeInlineText`: a
 * line break in any of them is always an artifact of the source, never authored
 * intent.
 *
 * WHERE NORMALIZATION RUNS — the one rule for the whole API
 * ---------------------------------------------------------
 * Normalize in the WRITE SERVICE, not in a Mongoose setter. The write service is
 * where the rest of the field's boundary validation already lives (display-name
 * policy, locale canonicalization, premium-color gate); it is the layer that can
 * reject a malformed payload with a structured 400, and it keeps the
 * transformation visible to the tests that cover that boundary. A setter instead
 * fixes up documents from every internal caller silently, which hides that same
 * class of bug.
 *
 * The rule has exactly ONE named exception: a field with NO single write
 * chokepoint. `File.originalName` (`models/File.ts`) is written by four
 * independent upload paths, so the schema field itself is the only place none of
 * them can bypass, and it therefore normalizes in a setter. A new normalized
 * field needs either a chokepoint or that same argument — nothing else.
 *
 * The one-shot backfill that normalized the already-stored corpus called these
 * functions rather than restating their rules, so a normalized-in-place row is
 * byte-identical to one written through the service today. It has run and been
 * deleted; any future sweep must call in here for the same reason.
 *
 * Length caps are applied here too: these are display strings coming from a
 * remote origin that we do not control, so an unbounded `og:description` cannot
 * be allowed to grow a user document without limit.
 */

import { normalizeInlineText } from '@oxyhq/core';
import { cleanDisplayName } from './displayNameSanitize';

/** Max stored length of a link card's title, in code units after normalization. */
export const MAX_LINK_TITLE_LENGTH = 200;

/** Max stored length of a link card's description. */
export const MAX_LINK_DESCRIPTION_LENGTH = 500;

/** Max stored length of a location's `name` / `label` and its address parts. */
export const MAX_LOCATION_TEXT_LENGTH = 200;

/** Max stored length of a profile link URL (matches the link-preview URL bound). */
export const MAX_LINK_URL_LENGTH = 2048;

/**
 * The address leaves of a `locations[]` entry. All of them are single-line
 * display values, and `formattedAddress` is Nominatim's raw `display_name`.
 */
const LOCATION_ADDRESS_TEXT_KEYS = [
  'street',
  'streetNumber',
  'streetDetails',
  'postalCode',
  'city',
  'state',
  'country',
  'formattedAddress',
] as const;

/** A JSON object reached through an `unknown` payload (the profile update body). */
type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a single-line display value and cap its length, trimming again in
 * case the cut landed on a boundary space.
 */
export function normalizeDisplayValue(value: string, maxLength: number): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength).trim();
}

/**
 * Normalize the string leaves of an object IN PLACE-free fashion: returns a new
 * object with `keys` run through `normalize` and every other key passed through
 * untouched (by reference). Keys that are absent, or hold a non-string, are left
 * exactly as they were — this function normalizes text, it does not validate shape.
 */
function withNormalizedKeys(
  source: UnknownRecord,
  keys: readonly string[],
  normalize: (value: string) => string
): UnknownRecord {
  const result: UnknownRecord = { ...source };
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string') {
      result[key] = normalize(value);
    }
  }
  return result;
}

/** The `normalize` argument of {@link withNormalizedKeys} for a capped display value. */
function inlineTextNormalizer(maxLength: number): (value: string) => string {
  return (value: string) => normalizeDisplayValue(value, maxLength);
}

/** The text leaves of the `name` sub-document. `full` is a schema VIRTUAL. */
const NAME_TEXT_KEYS = ['first', 'last'] as const;

/**
 * Canonicalize the `name` sub-document with the SAME cleaner the FEDERATED write
 * paths use (`cleanDisplayName`): NFC, the display-name character policy,
 * whitespace collapse, length cap.
 *
 * Before this, the native path was the odd one out. `sanitizeProfileUpdate` skips
 * `name`, the `NameSchema` has no `trim`, and `isValidDisplayName` only checks the
 * CHARACTER SET — a space is a legal display-name character, so `"Ana"` + 20
 * spaces + `"Gómez"` passed validation and was stored verbatim, while the exact
 * same string arriving from a federated actor was collapsed. In `user.service` the
 * character policy is validated (and rejected with a 400) BEFORE this runs, so
 * there the cleaner only ever has whitespace and length left to fix.
 *
 * Non-object values, and non-string parts, are passed through untouched for the
 * caller's own handling.
 */
export function normalizeProfileName(value: unknown): unknown {
  if (!isUnknownRecord(value)) return value;
  return withNormalizedKeys(value, NAME_TEXT_KEYS, cleanDisplayName);
}

/**
 * Normalize `linksMetadata[]`: the `title` / `description` scraped from a remote
 * page, and the `url` itself.
 *
 * Entries left over from a malformed payload — a non-object, or an entry whose
 * URL normalizes to nothing — are dropped: a link card with no URL is not a
 * link. Empty title/description are NOT invented here; the `linkMetadata`
 * controller already fills them from the URL when the remote page provides
 * neither, and the User schema requires them.
 *
 * A non-array input is returned untouched so the caller's own validation (or the
 * schema) reports the type error rather than this normalizer silently swallowing it.
 */
export function normalizeLinksMetadata(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const normalized: unknown[] = [];
  for (const entry of value) {
    if (!isUnknownRecord(entry)) continue;

    const url =
      typeof entry.url === 'string' ? normalizeDisplayValue(entry.url, MAX_LINK_URL_LENGTH) : '';
    if (!url) continue;

    const next: UnknownRecord = { ...entry, url };
    if (typeof entry.title === 'string') {
      next.title = normalizeDisplayValue(entry.title, MAX_LINK_TITLE_LENGTH);
    }
    if (typeof entry.description === 'string') {
      next.description = normalizeDisplayValue(entry.description, MAX_LINK_DESCRIPTION_LENGTH);
    }
    normalized.push(next);
  }
  return normalized;
}

/**
 * Normalize `locations[]`: the place `name` / `label` and every string leaf of
 * the nested `address` (whose `formattedAddress` is Nominatim's raw
 * `display_name`). Coordinates, metadata and timestamps pass through untouched.
 *
 * Non-object entries are dropped; a non-array input is returned untouched.
 */
export function normalizeLocations(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const normalized: unknown[] = [];
  for (const entry of value) {
    if (!isUnknownRecord(entry)) continue;

    const normalizeLocationText = inlineTextNormalizer(MAX_LOCATION_TEXT_LENGTH);
    const next = withNormalizedKeys(entry, ['name', 'label'], normalizeLocationText);
    if (isUnknownRecord(next.address)) {
      next.address = withNormalizedKeys(
        next.address,
        LOCATION_ADDRESS_TEXT_KEYS,
        normalizeLocationText
      );
    }
    normalized.push(next);
  }
  return normalized;
}

/**
 * Normalize `links[]`: a plain array of profile URLs. A URL can never contain
 * whitespace, so each entry is inline-normalized and entries that normalize to
 * nothing (or are not strings) are dropped.
 *
 * A non-array input is returned untouched.
 */
export function normalizeLinks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const url = normalizeDisplayValue(entry, MAX_LINK_URL_LENGTH);
    if (url) normalized.push(url);
  }
  return normalized;
}
