/**
 * Pure link helpers for the profile "links" editor. Kept out of the screen
 * component so they can be unit-tested without rendering React Native.
 */
import { PROFILE_LINK_TITLE_MAX } from '@oxy.so/contracts/client';

/** Strip the protocol and any trailing slash from a link URL for display. */
export const getLinkTitle = (url: string): string =>
  url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Human-readable description for a link URL. */
export const getLinkDescription = (url: string): string => `Link to ${url}`;

export interface LinkListItem {
  id: string;
  url: string;
  title: string;
  description: string;
}

/**
 * Build editable list items from a raw links array. The array can come from
 * legacy or untrusted profile data whose elements are not guaranteed to be
 * strings, so each entry is coerced with `String(item ?? '')` before formatting
 * — a non-string element must never crash the editor.
 */
export function linksToListItems(links: readonly unknown[]): LinkListItem[] {
  return links.map((item, i) => {
    const url = String(item ?? '');
    return {
      id: `link-${i}`,
      url,
      title: getLinkTitle(url),
      description: getLinkDescription(url),
    };
  });
}

/** Why a typed link cannot be added to the profile. */
export type LinkInputError = 'empty' | 'invalid' | 'insecure' | 'already-added' | 'limit';

/**
 * Normalize a typed link to the absolute https URL it names, or say why it
 * cannot be added. A bare host (`example.com/me`) gets `https://` in front; a
 * plain `http://` link is refused rather than silently upgraded, so the reader
 * sees the address they typed is the address that is saved.
 */
export function normalizeLinkInput(input: string): { url: string } | { error: LinkInputError } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'empty' };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { error: 'invalid' };
  }
  if (parsed.protocol === 'http:') return { error: 'insecure' };
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) {
    return { error: 'invalid' };
  }
  return { url: parsed.toString() };
}

/**
 * The identity two links share when they point at the same page: host without
 * `www.`, path without a trailing slash, and the query. Used to refuse a second
 * copy of a link already on the profile.
 */
export function linkIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Trim a title to the editor's limit, counting characters rather than UTF-16 units. */
export function clampLinkTitle(title: string): string {
  return Array.from(title).slice(0, PROFILE_LINK_TITLE_MAX).join('');
}

/** What the link form hands back when it is dismissed. */
export type LinkFormResult = { kind: 'save'; url: string; title: string } | { kind: 'remove' };

/**
 * The list after a link form result. A save appends a new link (if the profile
 * has room) or replaces the link at `index`; a remove drops it. `newId` makes
 * the id of an appended link, so the caller decides how ids are minted.
 */
export function applyLinkFormResult(
  items: readonly LinkListItem[],
  index: number | null,
  result: LinkFormResult,
  maxLinks: number,
  newId: () => string,
): LinkListItem[] {
  if (result.kind === 'remove') {
    return index === null ? [...items] : items.filter((_, i) => i !== index);
  }
  const title = clampLinkTitle(result.title.trim());
  const saved: LinkListItem = {
    id: index === null ? newId() : (items[index]?.id ?? newId()),
    url: result.url,
    title,
    description: getLinkDescription(result.url),
  };
  if (index === null) {
    return items.length >= maxLinks ? [...items] : [...items, saved];
  }
  return items.map((item, i) => (i === index ? saved : item));
}
