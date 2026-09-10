/**
 * Link-preview resolver tests: interstitial rejection, URL normalization, and
 * the generic Open Graph scrape over a mocked SSRF-safe fetch (returning RAW
 * origin image URLs — re-hosting happens later in the service).
 */
import { Readable } from 'stream';

const mockSafeFetch = jest.fn();

jest.mock('@oxy.so/core/server', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: class SsrfRejection extends Error {},
}));

import {
  isBlockedInterstitialUrl,
  normalizeUrl,
  resolveLinkMetadata,
} from '../linkMetadataResolver';

function htmlResponse(
  html: string,
  finalUrl: string,
  status = 200,
  headers: Record<string, string> = {},
): unknown {
  return {
    response: Readable.from([Buffer.from(html)]),
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    finalUrl,
  };
}

function jsonResponse(body: unknown, finalUrl: string, status = 200): unknown {
  return {
    response: Readable.from([Buffer.from(JSON.stringify(body))]),
    status,
    headers: { 'content-type': 'application/json' },
    finalUrl,
  };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('isBlockedInterstitialUrl', () => {
  it('rejects Google /sorry, consent.*, and accounts.google.com', () => {
    expect(isBlockedInterstitialUrl(new URL('https://www.google.com/sorry/index?continue=x'))).toBe(
      true,
    );
    expect(isBlockedInterstitialUrl(new URL('https://consent.youtube.com/m'))).toBe(true);
    expect(isBlockedInterstitialUrl(new URL('https://accounts.google.com/signin'))).toBe(true);
  });
  it('allows a normal page', () => {
    expect(isBlockedInterstitialUrl(new URL('https://example.com/article'))).toBe(false);
    expect(isBlockedInterstitialUrl(new URL('https://www.google.com/maps'))).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('prepends https:// when scheme missing', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a');
  });
  it('rejects empty/oversized', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('https://x.com/' + 'a'.repeat(3000))).toBeNull();
  });
});

describe('resolveLinkMetadata (generic scrape)', () => {
  it('extracts og tags and keeps the RAW absolute image URL', async () => {
    const html = `<html><head>
      <meta property="og:title" content="Great Article">
      <meta property="og:description" content="A &amp; B">
      <meta property="og:image" content="/img/cover.jpg">
      <meta property="og:site_name" content="Example">
    </head><body>...</body></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/article'));

    const result = await resolveLinkMetadata('https://example.com/article');
    expect(result.title).toBe('Great Article');
    expect(result.description).toBe('A & B');
    expect(result.siteName).toBe('Example');
    // RAW absolute origin URL (resolver does NOT re-host).
    expect(result.imageUrl).toBe('https://example.com/img/cover.jpg');
  });

  it('prefers og:title / og:description over the document <title> and meta description', async () => {
    const html = `<html><head>
      <title>Document Title – Example Site</title>
      <meta name="description" content="Document description">
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG description">
      <meta name="twitter:title" content="Twitter Title">
      <meta property="og:image" content="https://example.com/c.jpg">
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/article'));

    const result = await resolveLinkMetadata('https://example.com/article');
    expect(result.title).toBe('OG Title');
    expect(result.description).toBe('OG description');
    expect(result.imageUrl).toBe('https://example.com/c.jpg');
  });

  it('falls back to twitter:*, then the document tags, when og:* is absent', async () => {
    const html = `<html><head>
      <title>Document Title</title>
      <meta name="description" content="Document description">
      <meta name="twitter:title" content="Twitter Title">
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/article'));

    const result = await resolveLinkMetadata('https://example.com/article');
    expect(result.title).toBe('Twitter Title');
    expect(result.description).toBe('Document description');
  });

  it('uses an absolute canonical URL declared by the document', async () => {
    const html = `<html><head>
      <link rel="canonical" href="/canonical-article">
      <meta property="og:title" content="Canonical article">
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/tracked?id=1'));

    const result = await resolveLinkMetadata('https://short.example/article');
    expect(result.url).toBe('https://example.com/canonical-article');
  });

  it('uses og:url as canonical and rejects a non-http canonical link', async () => {
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(
      `<html><head>
        <link rel="canonical" href="javascript:alert(1)">
        <meta property="og:url" content="https://example.com/og-canonical">
        <meta property="og:title" content="Safe title">
      </head></html>`,
      'https://example.com/story',
    ));

    const result = await resolveLinkMetadata('https://example.com/story');
    expect(result.url).toBe('https://example.com/og-canonical');
  });

  it('extracts article JSON-LD when Open Graph is absent', async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle',
      headline: 'Structured headline',
      description: 'Structured description',
      image: { url: '/structured.jpg' },
    })}</script></head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/story'));

    const result = await resolveLinkMetadata('https://example.com/story');
    expect(result.title).toBe('Structured headline');
    expect(result.description).toBe('Structured description');
    expect(result.imageUrl).toBe('https://example.com/structured.jpg');
  });

  it('accepts explicit Open Graph metadata from a 401 paywall response', async () => {
    const html = `<html><head>
      <meta property="og:title" content="Public article title">
      <meta property="og:description" content="Public article description">
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/story', 401));

    const result = await resolveLinkMetadata('https://example.com/story');
    expect(result.title).toBe('Public article title');
    expect(result.description).toBe('Public article description');
  });

  it('does not cache metadata from a Cloudflare challenge response', async () => {
    const html = `<html><head><meta property="og:title" content="Challenge"></head></html>`;
    mockSafeFetch.mockResolvedValueOnce(
      htmlResponse(html, 'https://example.com/story', 403, { 'cf-mitigated': 'challenge' }),
    );

    const result = await resolveLinkMetadata('https://example.com/story');
    expect(result.title).toBeUndefined();
  });

  it('does not use a generic error-page title from a 404 response', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      htmlResponse('<html><head><title>Not found</title></head></html>', 'https://example.com/missing', 404),
    );

    const result = await resolveLinkMetadata('https://example.com/missing');
    expect(result.title).toBeUndefined();
  });


  it('collapses whitespace in a multi-line, indented <title>', async () => {
    const html = `<html><head>
      <title>
      Your &#8216;App&#8217; Could Have Been a Webpage (so I fixed it for you&#8230;) &#8211; Dan Q
    </title>
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://danq.me/a'));

    const result = await resolveLinkMetadata('https://danq.me/a');
    expect(result.title).toBe(
      'Your ‘App’ Could Have Been a Webpage (so I fixed it for you…) – Dan Q',
    );
  });

  it('collapses whitespace in og:title / og:description / og:site_name', async () => {
    const html = `<html><head>
      <meta property="og:title" content="  Spaced\n   Title  ">
      <meta property="og:description" content="Line one\n\n  line two ">
      <meta property="og:site_name" content="\n  Example\tSite\n">
    </head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/article'));

    const result = await resolveLinkMetadata('https://example.com/article');
    expect(result.title).toBe('Spaced Title');
    expect(result.description).toBe('Line one line two');
    expect(result.siteName).toBe('Example Site');
  });

  it('drops a whitespace-only title instead of storing it', async () => {
    const html = `<html><head><title>\n   \n</title></head></html>`;
    mockSafeFetch.mockResolvedValueOnce(htmlResponse(html, 'https://example.com/article'));

    const result = await resolveLinkMetadata('https://example.com/article');
    expect(result.title).toBeUndefined();
  });

  it('throws (without fetching) when the input URL is an interstitial wall', async () => {
    await expect(resolveLinkMetadata('https://www.google.com/sorry/index')).rejects.toThrow();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('throws when the FINAL url after redirects is an interstitial wall', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      htmlResponse('<html></html>', 'https://www.google.com/sorry/index'),
    );
    await expect(resolveLinkMetadata('https://news.example/x')).rejects.toThrow();
  });
});

describe('resolveLinkMetadata (provider path)', () => {
  it('collapses whitespace in an oEmbed title and description', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          title: '\n  A Clip\n  With a Wrapped Title\n',
          description: '  Clip\n\ndescription  ',
          thumbnail_url: 'https://i.vimeocdn.com/x.jpg',
        },
        'https://vimeo.com/api/oembed.json',
      ),
    );

    const result = await resolveLinkMetadata('https://vimeo.com/123');
    expect(result.title).toBe('A Clip With a Wrapped Title');
    expect(result.description).toBe('Clip description');
    expect(result.imageUrl).toBe('https://i.vimeocdn.com/x.jpg');
  });

  it('collapses whitespace in the description backfilled by the og enrichment scrape', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        jsonResponse(
          { title: 'Rick Astley', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' },
          'https://www.youtube.com/oembed',
        ),
      )
      .mockResolvedValueOnce(
        htmlResponse(
          `<html><head><meta property="og:description" content="Official
             video  "></head></html>`,
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ),
      );

    const result = await resolveLinkMetadata('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.title).toBe('Rick Astley');
    expect(result.description).toBe('Official video');
  });
});
