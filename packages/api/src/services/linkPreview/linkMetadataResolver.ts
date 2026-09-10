import type { IncomingHttpHeaders } from 'http';
import { URL } from 'url';
import { normalizeInlineText } from '@oxy.so/core';
import { safeFetch, SsrfRejection, type SafeFetchResult } from '@oxy.so/core/server';
import { logger } from '../../utils/logger';
import { decodeHtmlEntities } from '../../utils/sanitize';
import { linkMetadataProviders } from './linkMetadataProviders';
import { readBoundedBody } from './boundedBody';
import { hostnameOf } from './url';
import {
  LINK_PREVIEW_HTML_MAX_BYTES,
  LINK_PREVIEW_MAX_URL_LENGTH,
  LINK_PREVIEW_TIMEOUT_MS,
} from './constants';
import type { RawLinkMetadata } from './types';

/**
 * Generic link-metadata resolver (ported from Mention's `linkMetadataService`).
 *
 * Pipeline per URL:
 *   1. oEmbed provider chain (YouTube/Vimeo/Spotify) — see linkMetadataProviders.
 *   2. Generic Open Graph / Twitter-card scrape over the SSRF-safe {@link safeFetch}
 *      (head-bounded read that early-stops at `</head>`).
 *
 * Output is RAW metadata — `imageUrl` / `faviconUrl` are the absolute REMOTE
 * (origin) URLs. The link-preview service re-hosts them onto Oxy media before
 * returning anything to a client (privacy invariant). The resolver itself never
 * touches S3/CDN.
 *
 * SSRF: every outbound fetch (and every redirect hop) is validated and the TCP
 * connection pinned by {@link safeFetch}. There is no separate validate-then-fetch
 * window. The Bun `lookup {all:true}` array contract is owned inside safeFetch.
 */

/** The HTML head-close marker the streaming read stops at (ASCII, case-insensitive). */
const HEAD_CLOSE_MARKER = '</head>';

/** Browser-like UA so hosts that vary content for bots still serve OG tags. */
const SCRAPE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Matches any Google host (with or without a `www.` prefix), e.g. `google.com`, `www.google.co.uk`. */
const GOOGLE_HOST = /^(www\.)?google\.[a-z.]+$/;

/** Read a single header value (collapsing the `string[] | undefined` shape). */
function headerStr(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Detect an anti-bot / consent / login interstitial page that serves a 200
 * response carrying no real Open Graph metadata. Following (or landing on) such
 * a page and parsing it caches junk — e.g. Google's `/sorry` wall renders the
 * request URL as its `<title>`, which then looks like a usable preview.
 *
 * Intentionally narrow so legitimate cross-domain redirects (`youtu.be` →
 * `youtube.com`) are still followed:
 *  - Google's `/sorry` anti-bot / CAPTCHA wall on any `google.<tld>` host.
 *  - Cookie-consent gates on any `consent.*` host.
 *  - The Google login wall at `accounts.google.com`.
 */
export function isBlockedInterstitialUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();

  if (GOOGLE_HOST.test(host) && url.pathname.toLowerCase().startsWith('/sorry')) {
    return true;
  }
  if (host.startsWith('consent.')) {
    return true;
  }
  if (host === 'accounts.google.com') {
    return true;
  }
  return false;
}

/** Normalize a raw input URL, defaulting a missing scheme to `https://`. */
export function normalizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let normalized = url.trim();
  if (!normalized) return null;
  if (normalized.length > LINK_PREVIEW_MAX_URL_LENGTH) return null;

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    return new URL(normalized).toString();
  } catch {
    return null;
  }
}

function extractSiteName(url: string): string {
  return hostnameOf(url)?.replace(/^www\./, '') ?? 'Link';
}

/**
 * Resolve a possibly-relative image/favicon URL against the page's base URL.
 * `new URL(trimmed, baseUrl)` already resolves protocol-relative (`//host/x`),
 * root-relative (`/x`), and plain-relative (`x`, `../x`) inputs, so the only
 * special case is an already-absolute `http(s)` URL (returned as-is).
 */
function resolveAbsoluteUrl(value: string, baseUrl: string): string {
  if (!value || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return value;
  }
}

function resolveCanonicalUrl(values: Array<string | undefined>, fallbackUrl: string): string {
  for (const value of values) {
    if (!value) continue;
    const resolved = resolveAbsoluteUrl(value, fallbackUrl);
    try {
      const parsed = new URL(resolved);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // Try the next declared canonical representation.
    }
  }
  return fallbackUrl;
}

/** Extract `<title>` + meta/link tags from the HTML head (regex; no full DOM parse). */
function extractMetadataFromHtml(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch?.[1] ?? html.slice(0, 128 * 1024);
  // The value class is `[\s\S]` (not `.`): an attribute value may legitimately
  // span source lines (a long `og:description` wrapped by the page author), and
  // with `.` the lazy match stops at the first newline, so the attribute — hence
  // the whole meta tag — is dropped. It stays bounded by the enclosing tag either
  // way.
  const attrPattern = /([a-zA-Z_:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;

  for (const tagMatch of head.matchAll(
    /<(title|meta|link)\b[^>]*>([\s\S]*?)<\/\1>|<(meta|link)\b[^>]*\/?\s*>/gi,
  )) {
    const fullTag = tagMatch[0];
    const tagName = (tagMatch[1] || tagMatch[3] || '').toLowerCase();
    if (tagName === 'title') {
      metadata.title = decodeHtmlEntities(tagMatch[2] || '');
      continue;
    }

    const attrs: Record<string, string> = {};
    attrPattern.lastIndex = 0;
    for (const attr of fullTag.matchAll(attrPattern)) {
      attrs[attr[1].toLowerCase()] = decodeHtmlEntities(attr[3]);
    }

    if (tagName === 'meta') {
      const key = attrs.property || attrs.name;
      if (key && attrs.content) metadata[key.toLowerCase()] = attrs.content;
    } else if (tagName === 'link' && attrs.rel?.toLowerCase().includes('icon') && attrs.href) {
      metadata.favicon = attrs.href;
    } else if (
      tagName === 'link' &&
      attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') &&
      attrs.href
    ) {
      metadata.canonical = attrs.href;
    }
  }

  // JSON-LD is the standards-based fallback used by many article/product pages
  // that omit Open Graph. Only consume the small, presentation-safe subset a
  // preview needs; arbitrary structured data never leaves this resolver.
  for (const script of head.matchAll(
    /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[2]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : isJsonRecord(parsed) && Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
    const entity = candidates.find((candidate) => {
      if (!isJsonRecord(candidate)) return false;
      const type = candidate['@type'];
      const types = Array.isArray(type) ? type : [type];
      return types.some((value) =>
        typeof value === 'string' && [
          'Article',
          'NewsArticle',
          'BlogPosting',
          'WebPage',
          'Product',
          'VideoObject',
          'Event',
          'Recipe',
        ].includes(value),
      );
    });
    if (!isJsonRecord(entity)) continue;
    const imageUrl = readJsonLdImage(entity.image) ?? readJsonLdImage(entity.thumbnailUrl);
    const title = typeof entity.headline === 'string'
      ? entity.headline
      : typeof entity.name === 'string' ? entity.name : undefined;
    if (title) metadata['jsonld:title'] = title;
    if (typeof entity.description === 'string') {
      metadata['jsonld:description'] = entity.description;
    }
    if (imageUrl) metadata['jsonld:image'] = imageUrl;
    break;
  }

  return metadata;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readJsonLdImage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = readJsonLdImage(entry);
      if (url) return url;
    }
    return undefined;
  }
  if (typeof value === 'string') return value;
  return isJsonRecord(value) && typeof value.url === 'string' ? value.url : undefined;
}

/**
 * Fetch a page and extract its head metadata. `safeFetch` follows (and
 * re-validates) redirects internally, so this checks the interstitial guard on
 * BOTH the input URL (before fetching) and the final resolved URL (after).
 *
 * @throws on an interstitial wall, an SSRF rejection, or a transport/timeout
 *   failure. A non-2xx or non-HTML response resolves to empty metadata.
 */
async function fetchMetadataDocument(
  initialUrl: string,
): Promise<{ metadata: Record<string, string>; finalUrl: string }> {
  let parsedInput: URL;
  try {
    parsedInput = new URL(initialUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (isBlockedInterstitialUrl(parsedInput)) {
    throw new Error(`Blocked interstitial page: ${parsedInput.hostname}${parsedInput.pathname}`);
  }

  let result: SafeFetchResult;
  try {
    result = await safeFetch(initialUrl, {
      method: 'GET',
      headers: {
        'User-Agent': SCRAPE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
      headersTimeoutMs: LINK_PREVIEW_TIMEOUT_MS,
      signal: AbortSignal.timeout(LINK_PREVIEW_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SsrfRejection) {
      logger.warn('[linkPreviewResolver] page fetch blocked by SSRF guard', {
        url: initialUrl,
        reason: error.message,
      });
      throw new Error('URL security validation failed');
    }
    throw error;
  }

  const { response, status, headers } = result;
  try {
    let finalParsed: URL;
    try {
      finalParsed = new URL(result.finalUrl);
    } catch {
      finalParsed = parsedInput;
    }
    if (isBlockedInterstitialUrl(finalParsed)) {
      throw new Error(`Blocked interstitial page: ${finalParsed.hostname}${finalParsed.pathname}`);
    }

    const challengeHeader = headerStr(headers['cf-mitigated']).toLowerCase();
    if (challengeHeader === 'challenge') {
      return { metadata: {}, finalUrl: result.finalUrl };
    }

    if (status < 200 || status >= 500) {
      return { metadata: {}, finalUrl: result.finalUrl };
    }

    const contentType = headerStr((headers as IncomingHttpHeaders)['content-type']).toLowerCase();
    if (contentType && !contentType.includes('html')) {
      return { metadata: {}, finalUrl: result.finalUrl };
    }

    const html = await readBoundedBody(response, {
      maxBytes: LINK_PREVIEW_HTML_MAX_BYTES,
      stopMarker: HEAD_CLOSE_MARKER,
    });
    const metadata = extractMetadataFromHtml(html);
    // On 4xx pages accept only explicit share/structured metadata. A generic
    // login or error-page <title> must never become the article's cached title.
    const hasExplicitPreviewMetadata = Object.keys(metadata).some(
      (key) =>
        key.startsWith('og:') || key.startsWith('twitter:') || key.startsWith('jsonld:'),
    );
    if (status >= 400 && !hasExplicitPreviewMetadata) {
      return { metadata: {}, finalUrl: result.finalUrl };
    }
    return { metadata, finalUrl: result.finalUrl };
  } finally {
    response.destroy();
  }
}

/**
 * Decode HTML entities, then run the value through the ecosystem's canonical
 * single-line normalizer ({@link normalizeInlineText}: NFC, every whitespace run
 * — newlines, tabs, indentation, NBSP — collapsed to one space, trimmed).
 * Returns `undefined` when the field holds no text at all, so a whitespace-only
 * value never counts as metadata.
 *
 * WHY: a `<title>` authored across indented source lines —
 * `<title>\n      Some Page – Site\n    </title>` — is captured verbatim by the
 * head extractor, and clients render preview text in a React Native `Text`
 * (`white-space: pre-wrap` on web), where those newlines survive as a blank line
 * plus a leading indent inside the card. oEmbed/provider titles carry the same
 * risk, which is why this runs at the shared {@link finalize} chokepoint rather
 * than in the HTML extractor.
 */
function normalizeMetadataText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeInlineText(decodeHtmlEntities(value));
  return normalized.length > 0 ? normalized : undefined;
}

/** Decode + whitespace-normalize the text fields; absolutize the URL fields. */
function finalize(result: RawLinkMetadata, baseUrl: string): RawLinkMetadata {
  result.title = normalizeMetadataText(result.title);
  result.description = normalizeMetadataText(result.description);
  result.siteName = normalizeMetadataText(result.siteName);
  if (result.imageUrl) result.imageUrl = resolveAbsoluteUrl(result.imageUrl, baseUrl);
  if (result.faviconUrl) result.faviconUrl = resolveAbsoluteUrl(result.faviconUrl, baseUrl);
  return result;
}

/**
 * Run the ordered oEmbed provider chain. Returns the first matching provider's
 * resolved metadata, or `null` when no provider matches / the provider yields
 * nothing (caller falls through to the generic scrape). When the provider
 * result carries no description, a best-effort generic OG scrape fills it; any
 * failure leaves the description undefined and never fails the provider result.
 */
async function resolveViaProvider(normalizedUrl: string): Promise<RawLinkMetadata | null> {
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return null;
  }

  const provider = linkMetadataProviders.find((candidate) => candidate.matches(parsed));
  if (!provider) return null;

  let result: RawLinkMetadata | null;
  try {
    result = await provider.resolve(parsed);
  } catch (error) {
    logger.warn('[linkPreviewResolver] oEmbed provider failed; falling back to generic scrape', {
      provider: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!result) return null;

  if (!result.description) {
    try {
      const { metadata } = await fetchMetadataDocument(result.url);
      const description = metadata['og:description'] || metadata['twitter:description'];
      if (description && description.trim().length > 0) {
        result.description = description;
      }
    } catch (error) {
      logger.debug('[linkPreviewResolver] provider description enrichment skipped', {
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Resolve RAW link metadata for a NORMALIZED URL. Throws on a hard failure
 * (invalid URL, interstitial wall, SSRF rejection, timeout) so the caller marks
 * the URL empty/negative; returns raw metadata (possibly sparse) on success.
 */
export async function resolveLinkMetadata(normalizedUrl: string): Promise<RawLinkMetadata> {
  const providerResult = await resolveViaProvider(normalizedUrl);
  if (providerResult) {
    return finalize(providerResult, providerResult.url);
  }

  const { metadata, finalUrl } = await fetchMetadataDocument(normalizedUrl);
  // Open Graph first, then the Twitter card, then the plain document tags. OG
  // exists precisely to carry the share-optimized title/description, so it wins:
  // a page's `<title>` routinely appends a site suffix ("Article – Dan Q") that
  // duplicates the siteName the card already shows, while `og:title` is clean.
  // This matches how Slack/Twitter/Facebook/Mastodon unfurl.
  const canonicalUrl = resolveCanonicalUrl([metadata.canonical, metadata['og:url']], finalUrl);
  const result: RawLinkMetadata = {
    url: canonicalUrl,
    title:
      metadata['og:title'] ||
      metadata['twitter:title'] ||
      metadata['jsonld:title'] ||
      metadata.title,
    description:
      metadata['og:description'] ||
      metadata['twitter:description'] ||
      metadata['jsonld:description'] ||
      metadata.description,
    imageUrl:
      metadata['og:image'] ||
      metadata['twitter:image'] ||
      metadata['jsonld:image'] ||
      metadata.image,
    siteName: metadata['og:site_name'] || extractSiteName(canonicalUrl),
    faviconUrl: metadata.favicon,
  };
  return finalize(result, canonicalUrl);
}
