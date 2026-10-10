/**
 * Pure link-display helpers for the profile "links" editor. Kept out of the
 * screen component so the string-coercion guard can be unit-tested without
 * rendering the whole React Native screen.
 */

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
