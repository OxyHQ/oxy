/**
 * Where an HLS rendition's segments live.
 *
 * A playlist's URIs resolve against its own URL (RFC 8216 §4.3.4.2), so the
 * assertion that matters is RESOLUTION, done the way a player does it — with
 * `new URL(uri, playlistUrl)` — not that a key "looks right". The generator used
 * to store `hls_360p_segment_360p_000.ts.ts` for a playlist that lists
 * `segment_360p_000.ts`, and every segment of every ladder 403'd.
 */

import {
  isHlsRenditionVariant,
  legacySegmentKeys,
  playlistSiblingKey,
  playlistUris,
} from '../hlsPlaylist';

const SHA = '1686a685fa7adaa11d4102f6696ea97d0e70d6789ca604e414edcfb95d7bce06';
const PLAYLIST_KEY = `public/variants/2026/10/16/${SHA}/hls_360p.m3u8`;

/** What CloudFront serves for a `public/` key: the key without its prefix. */
const cdnUrl = (key: string) => `https://cloud.oxy.so/${key.replace(/^public\//, '')}`;

/** A rendition playlist exactly as ffmpeg writes it. */
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:12',
  '#EXTINF:11.520000,',
  'segment_360p_000.ts',
  '#EXTINF:9.600000,',
  'segment_360p_001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

describe('hlsPlaylist', () => {
  it('reads the URI lines a player follows, in order', () => {
    expect(playlistUris(PLAYLIST)).toEqual(['segment_360p_000.ts', 'segment_360p_001.ts']);
  });

  it('stores a segment where a player resolves it from the playlist', () => {
    for (const uri of playlistUris(PLAYLIST)) {
      const resolved = new URL(uri, cdnUrl(PLAYLIST_KEY)).toString();
      expect(cdnUrl(playlistSiblingKey(PLAYLIST_KEY, uri))).toBe(resolved);
    }
  });

  it('tells rendition playlists from the master', () => {
    expect(isHlsRenditionVariant('hls_360p')).toBe(true);
    expect(isHlsRenditionVariant('hls_source')).toBe(true);
    expect(isHlsRenditionVariant('hls_master')).toBe(false);
    expect(isHlsRenditionVariant('poster')).toBe(false);
  });

  it('finds a legacy-named segment in either spelling of the directory', () => {
    expect(legacySegmentKeys(PLAYLIST_KEY, 'hls_360p', 'segment_360p_000.ts')).toEqual([
      `public/variants/2026/10/16/${SHA}/hls_360p_segment_360p_000.ts.ts`,
      `variants/2026/10/16/${SHA}/hls_360p_segment_360p_000.ts.ts`,
    ]);
  });
});
