/**
 * Input Sanitization Utilities
 *
 * Two distinct strategies, chosen by how the value is consumed downstream:
 *
 *  - `sanitizePlainText` — for FREE-TEXT fields that clients render as TEXT
 *    (bio, description, address, …). RN/React auto-escape text at render time,
 *    so storing HTML-entity-escaped data is wrong: it surfaces literal
 *    `&#x27;` / `&amp;` to users (e.g. `I don&#x27;t`). This helper decodes any
 *    entities and strips tags instead. Use it for anything shown as text.
 *
 *  - `sanitizeHtml` — entity-escaping for values placed into an actual
 *    HTML/markup context. Do NOT use it on text fields or MongoDB `$regex`
 *    inputs (see `sanitizeSearchQuery`).
 *
 * Never apply either to passwords, hashes, or binary data.
 *
 * Whitespace/Unicode normalization is NOT implemented here: `sanitizePlainText`
 * delegates it to the canonical `normalizeMultilineText` from `@oxyhq/core`.
 * This module owns only entity decoding and tag stripping.
 */

import { normalizeMultilineText } from '@oxyhq/core';

/**
 * Escape HTML special characters to prevent XSS.
 *
 * Replaces: & < > " '
 */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Decode common HTML entities back to their literal characters.
 *
 * Handles numeric (`&#39;`), hex (`&#x27;`), and the named entities `&amp;`,
 * `&lt;`, `&gt;`, `&quot;`, `&apos;`. This is the inverse of {@link sanitizeHtml}
 * for the subset of entities Oxy ever produces, and is used to un-escape data
 * that was previously stored HTML-escaped (e.g. federated display names /
 * link-preview metadata) before re-processing it.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Sanitize a FREE-TEXT field that clients render as TEXT (bio, description,
 * address, location, etc.).
 *
 * WHY this exists instead of `sanitizeHtml`: these fields are displayed as text
 * in RN/React clients, which auto-escape markup at render time. That render-time
 * escaping — combined with the tag-stripping below — is the XSS protection, NOT
 * HTML-entity-escaping at storage. Storing entity-escaped data (`sanitizeHtml`)
 * is actively harmful: the client double-escapes it and the user sees a literal
 * `I don&#x27;t` / `Arthur &amp; Thomas`, and re-escaping already-escaped remote
 * input (federated bios) compounds the corruption.
 *
 * Strategy:
 *  1. Decode HTML entities first — undoes any prior escaping and remote-encoded
 *     input, AND turns an encoded `&lt;script&gt;` into a real tag so step 2 can
 *     remove it (no executable markup survives into storage).
 *  2. Strip all HTML tags.
 *  3. Normalize the whitespace with the canonical {@link normalizeMultilineText}:
 *     the author's line breaks survive (this is a BODY, not a title), while the
 *     horizontal whitespace at BOTH ends of each line is removed and runs of
 *     blank lines collapse to one.
 *
 * Step 3 is stricter than the collapse this function used to do inline: a line
 * whose only content is spaces (`"a\n   \n   \nb"`) used to survive intact,
 * because a bare `\n{3,}` collapse never sees a run of blank lines that spaces
 * have broken up — and clients render these fields in an RN `Text`
 * (`white-space: pre-wrap`), so the reader saw the extra blank lines. That is
 * the bug the canonical helper fixes. Leading indentation on a line is dropped
 * for the same reason: once the runs of horizontal whitespace collapse, an indent
 * is already destroyed as an indent, and what is left is a stray leading space —
 * an artifact of the source markup, not of the author.
 *
 * Idempotent: running it on its own output yields the same string.
 */
export function sanitizePlainText(input: string): string {
  if (!input) return input;
  const decoded = decodeHtmlEntities(input);
  const stripped = decoded.replace(/<[^>]*>/g, '');
  return normalizeMultilineText(stripped);
}

/**
 * Sanitize a string if it's a string, otherwise return as-is.
 */
export function sanitizeString(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeHtml(value);
  }
  return value;
}

/**
 * Sanitize all string values in an object (shallow — one level deep) for TEXT
 * rendering: each string is run through `sanitizePlainText` (decode + strip
 * tags), preserving the literal characters clients display as text rather than
 * HTML-entity-escaping them.
 *
 * Skips fields listed in `skipFields` (e.g. passwords, tokens).
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  skipFields: string[] = []
): T {
  const result = { ...obj };
  // `result` is the generic `T`, whose per-key value types TypeScript won't let
  // us reassign through. Mutate it via a `Record<string, unknown>` view of the
  // same object (an upcast of the `T extends Record<string, unknown>` bound),
  // then return the original reference so the caller keeps the `T` shape.
  const writable = result as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (skipFields.includes(key)) continue;
    const value = writable[key];
    if (typeof value === 'string') {
      writable[key] = sanitizePlainText(value);
    }
  }
  return result;
}

/**
 * Sanitize user profile update fields.
 *
 * Every profile field handled here is rendered as TEXT by clients, so values
 * are run through `sanitizePlainText` (decode + strip tags) — NOT HTML-entity-
 * escaped. Escaping would surface literal `&#x27;` / `&amp;` in bios,
 * descriptions, addresses, etc. (see `sanitizePlainText` for the rationale).
 * Skips non-text fields: avatar (file ID), color, email, password, links
 * (URLs), linksMetadata, locations.
 *
 * `name` is intentionally skipped: display names are validated against a strict
 * letters/spaces/apostrophe/separator policy upstream (see `utils/displayNameSanitize.ts`)
 * and are already clean, so reprocessing them here is unnecessary.
 *
 * The skipped fields are NOT unnormalized — they are structured values (a name
 * sub-document, arrays of link/location objects) that this shallow string walker
 * cannot reach into. `user.service`'s `normalizeProfileField` is their write-path
 * chokepoint: it runs `cleanDisplayName` over `name`, and the canonical inline
 * normalizer over `linksMetadata` / `locations` / `links`
 * (see `utils/profileTextNormalization.ts`).
 */
export function sanitizeProfileUpdate(updates: Record<string, unknown>): Record<string, unknown> {
  const skipFields = ['name', 'avatar', 'color', 'email', 'password', 'links', 'linksMetadata', 'locations'];
  const result = { ...updates };

  for (const key of Object.keys(result)) {
    if (skipFields.includes(key)) continue;
    const value = result[key];
    if (typeof value === 'string') {
      result[key] = sanitizePlainText(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Handle nested objects like `notificationPreferences` / `userPreferences`
      result[key] = sanitizeObject(value as Record<string, unknown>);
    }
  }

  return result;
}

/**
 * Escape regex metacharacters to prevent ReDoS and injection
 * when using user input in MongoDB $regex queries.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize a search query string for MongoDB `$regex` use.
 *
 * Trims, limits length, and escapes regex metacharacters. HTML entity-escaping
 * is intentionally omitted — stored usernames/names are literal text (e.g.
 * `O'Brien`), and escaping would make the regex search for `O&#x27;Brien`
 * instead.
 */
export function sanitizeSearchQuery(query: string, maxLength = 100): string {
  const trimmed = query.trim().slice(0, maxLength);
  return escapeRegex(trimmed);
}
