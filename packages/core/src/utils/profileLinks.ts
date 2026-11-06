/**
 * Normalized profile link shape for display.
 *
 * `id` is a stable key for list rendering (the source entry's id when present,
 * otherwise the source index as a string). `url` is always a non-empty string.
 * `title`, `description`, and `image` are carried through from `linksMetadata`
 * only when present; the legacy `links: string[]` path produces just
 * `{ id, url }`.
 */
export interface ProfileLink {
  id: string;
  title?: string;
  url: string;
  description?: string;
  image?: string;
  /** Clarity's favicon for the link's host, when Clarity has one. */
  faviconUrl?: string;
}

/** Source shape of a single `User.linksMetadata` entry. */
export interface ProfileLinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  id?: string;
  faviconUrl?: string;
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes a user's profile links into a clean display shape.
 *
 * Pure, no side effects, no I/O.
 *
 * - Prefers `linksMetadata` when it is a non-empty array: maps each entry to
 *   `{ id, title, url, description, image }`, using `entry.id` when present and
 *   falling back to the entry index. `title`, `description`, and `image` are
 *   carried through only when they are present strings. Entries without a
 *   non-empty string `url` are dropped.
 * - Otherwise falls back to the legacy `links` string array: maps each string to
 *   `{ id: <index>, url }` (no title/description/image). Empty/non-string values
 *   are dropped.
 * - Returns `[]` when both are absent or empty (including when `linksMetadata`
 *   is present but every entry is dropped — it does NOT fall back to `links`).
 *
 * URLs are trimmed and blanks are filtered out. This does NOT add a scheme such
 * as `https://`; prefixing is a display concern left to the caller.
 */
export function normalizeProfileLinks(
  linksMetadata?: ProfileLinkMetadata[],
  links?: string[],
): ProfileLink[] {
  if (Array.isArray(linksMetadata) && linksMetadata.length > 0) {
    const result: ProfileLink[] = [];
    linksMetadata.forEach((entry, index) => {
      const url = cleanUrl(entry?.url);
      if (!url) return;
      const id =
        typeof entry?.id === 'string' && entry.id.trim().length > 0 ? entry.id : String(index);
      const title = typeof entry?.title === 'string' ? entry.title : undefined;
      const description = typeof entry?.description === 'string' ? entry.description : undefined;
      const image = typeof entry?.image === 'string' ? entry.image : undefined;
      const faviconUrl = typeof entry?.faviconUrl === 'string' ? entry.faviconUrl : undefined;
      result.push({
        id,
        url,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(image !== undefined ? { image } : {}),
        ...(faviconUrl !== undefined ? { faviconUrl } : {}),
      });
    });
    return result;
  }

  if (Array.isArray(links) && links.length > 0) {
    const result: ProfileLink[] = [];
    links.forEach((value, index) => {
      const url = cleanUrl(value);
      if (!url) return;
      result.push({ id: String(index), url });
    });
    return result;
  }

  return [];
}

/** A platform a profile can point supporters to, recognised by the link's host. */
export interface SupportProvider {
  id: 'patreon' | 'kofi' | 'buymeacoffee' | 'github-sponsors' | 'liberapay';
  name: string;
}

const SUPPORT_PROVIDERS: readonly { provider: SupportProvider; hosts: readonly string[] }[] = [
  { provider: { id: 'patreon', name: 'Patreon' }, hosts: ['patreon.com'] },
  { provider: { id: 'kofi', name: 'Ko-fi' }, hosts: ['ko-fi.com'] },
  { provider: { id: 'buymeacoffee', name: 'Buy Me a Coffee' }, hosts: ['buymeacoffee.com'] },
  { provider: { id: 'github-sponsors', name: 'GitHub Sponsors' }, hosts: ['github.com'] },
  { provider: { id: 'liberapay', name: 'Liberapay' }, hosts: ['liberapay.com'] },
];

/**
 * The support platform a link points at, or `null`. GitHub Sponsors is the one
 * host shared with ordinary GitHub pages, so only its `/sponsors/` path counts.
 */
export function supportProviderOf(url: string): SupportProvider | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  for (const { provider, hosts } of SUPPORT_PROVIDERS) {
    if (!hosts.some((known) => host === known || host.endsWith(`.${known}`))) continue;
    if (
      provider.id === 'github-sponsors' &&
      !parsed.pathname.toLowerCase().startsWith('/sponsors/')
    ) {
      continue;
    }
    return provider;
  }
  return null;
}
