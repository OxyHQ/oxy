/**
 * Link-preview oEmbed provider tests: host/path matching, YouTube id extraction,
 * and provider.resolve over a mocked SSRF-safe fetch.
 */
import { Readable } from 'stream';

const mockSafeFetch = jest.fn();

jest.mock('@oxy.so/core/server', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: class SsrfRejection extends Error {},
}));

import {
  linkMetadataProviders,
  extractYoutubeVideoId,
} from '../linkMetadataProviders';

function jsonResponse(body: unknown, status = 200): unknown {
  return {
    response: Readable.from([Buffer.from(JSON.stringify(body))]),
    status,
    headers: { 'content-type': 'application/json' },
    finalUrl: 'https://provider.example/oembed',
  };
}

const youtube = linkMetadataProviders.find((p) => p.id === 'youtube');
const vimeo = linkMetadataProviders.find((p) => p.id === 'vimeo');
const spotify = linkMetadataProviders.find((p) => p.id === 'spotify');

beforeEach(() => {
  mockSafeFetch.mockReset();
});

describe('extractYoutubeVideoId', () => {
  it('extracts from watch?v=', () => {
    expect(extractYoutubeVideoId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(
      'dQw4w9WgXcQ',
    );
  });
  it('extracts from youtu.be short link', () => {
    expect(extractYoutubeVideoId(new URL('https://youtu.be/dQw4w9WgXcQ?si=abc'))).toBe(
      'dQw4w9WgXcQ',
    );
  });
  it('extracts from /shorts/<id>', () => {
    expect(extractYoutubeVideoId(new URL('https://www.youtube.com/shorts/dQw4w9WgXcQ'))).toBe(
      'dQw4w9WgXcQ',
    );
  });
  it('returns null for a non-video page', () => {
    expect(extractYoutubeVideoId(new URL('https://www.youtube.com/feed/subscriptions'))).toBeNull();
  });
  it('returns null for a malformed id', () => {
    expect(extractYoutubeVideoId(new URL('https://youtu.be/tooshort'))).toBeNull();
  });
});

describe('provider matching', () => {
  it('youtube matches its hosts only', () => {
    expect(youtube?.matches(new URL('https://music.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(true);
    expect(youtube?.matches(new URL('https://example.com/watch?v=dQw4w9WgXcQ'))).toBe(false);
  });
  it('vimeo + spotify match their hosts', () => {
    expect(vimeo?.matches(new URL('https://vimeo.com/123'))).toBe(true);
    expect(spotify?.matches(new URL('https://open.spotify.com/track/abc'))).toBe(true);
    expect(spotify?.matches(new URL('https://spotify.com/track/abc'))).toBe(false);
  });
});

describe('provider.resolve', () => {
  it('youtube returns raw thumbnail as imageUrl and no description', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      jsonResponse({ title: 'Rick Astley', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' }),
    );
    const result = await youtube?.resolve(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    expect(result).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      siteName: 'YouTube',
      title: 'Rick Astley',
      imageUrl: 'https://i.ytimg.com/vi/x/hq.jpg',
    });
    expect(result?.description).toBeUndefined();
  });

  it('vimeo carries through the oEmbed description', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      jsonResponse({ title: 'Clip', description: 'A clip', thumbnail_url: 'https://i.vimeocdn.com/x.jpg' }),
    );
    const result = await vimeo?.resolve(new URL('https://vimeo.com/123'));
    expect(result?.description).toBe('A clip');
    expect(result?.imageUrl).toBe('https://i.vimeocdn.com/x.jpg');
  });

  it('returns null on a non-2xx oEmbed response (falls through to scrape)', async () => {
    mockSafeFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const result = await spotify?.resolve(new URL('https://open.spotify.com/track/abc'));
    expect(result).toBeNull();
  });

  it('youtube returns null for a non-video URL without fetching', async () => {
    const result = await youtube?.resolve(new URL('https://www.youtube.com/feed/home'));
    expect(result).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
