/**
 * The HLS master playlist's rendition URIs.
 *
 * A master playlist's URIs resolve against the MASTER's own URL (RFC 8216
 * §4.3.4.2), and `generateVariantKey` writes the master and every rendition into
 * one directory — `variants/<year>/<month>/<prefix>/<sha256>/<type>.m3u8`. So a
 * rendition must be named by its file name alone.
 *
 * It was emitting the S3 STORAGE KEY instead, which made every ladder this
 * service has ever produced unplayable. Measured against production before the
 * fix:
 *
 *   master   cloud.oxy.so/variants/2026/09/e8/<sha>/hls_master.m3u8      200
 *   its URI  public/variants/2026/09/e8/<sha>/hls_360p.m3u8
 *   resolves cloud.oxy.so/variants/2026/09/e8/<sha>/public/variants/…    403
 *   correct  cloud.oxy.so/variants/2026/09/e8/<sha>/hls_360p.m3u8        200
 *
 * Nothing on the server can see that: the master is served, S3 holds every
 * object, and the only broken thing is a string inside a text file. So the
 * assertion that matters is not "the URI looks right" — it is RESOLUTION, done
 * the way a player does it, with `new URL(uri, masterUrl)`.
 *
 * The formatter is private and pure, reached through a typed harness rather than
 * `as any`, mirroring `emailService.unsubscribe.test.ts`.
 */

import { VariantService } from '../variantService';
import type { S3Service } from '../s3Service';

interface MasterPlaylistHarness {
  generateMasterPlaylist(
    variants: Array<{ resolution: string; bitrate: string; playlist: string }>,
  ): string;
}

const SHA = 'e80e2cc4c0d81707301d5d3064299cbaf2884eaf03fb1aa54803a70c956d957a';
const MASTER_URL = `https://cloud.oxy.so/variants/2026/09/e8/${SHA}/hls_master.m3u8`;

/** The shape `generateHLSStream` builds: `playlist` is the S3 key it uploaded. */
function rendition(type: string, resolution: string, bitrate: string) {
  return {
    resolution,
    bitrate,
    playlist: `public/variants/2026/09/e8/${SHA}/${type}.m3u8`,
  };
}

const service = new VariantService({} as unknown as S3Service) as unknown as MasterPlaylistHarness;

/** Every URI line, in order — the lines that are neither blank nor a tag. */
function uris(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('VariantService master playlist', () => {
  it('names each rendition as a sibling of the master, not by its storage key', () => {
    const playlist = service.generateMasterPlaylist([
      rendition('hls_360p', '640x360', '500k'),
      rendition('hls_720p', '1280x720', '1M'),
    ]);

    expect(uris(playlist)).toEqual(['hls_360p.m3u8', 'hls_720p.m3u8']);
  });

  it('resolves to the rendition beside the master, the way a player resolves it', () => {
    const playlist = service.generateMasterPlaylist([rendition('hls_360p', '640x360', '500k')]);

    const [uri] = uris(playlist);
    expect(new URL(uri, MASTER_URL).toString()).toBe(
      `https://cloud.oxy.so/variants/2026/09/e8/${SHA}/hls_360p.m3u8`,
    );
  });

  it('keeps the bandwidth and resolution attributes each URI belongs to', () => {
    const playlist = service.generateMasterPlaylist([
      rendition('hls_360p', '640x360', '500k'),
      rendition('hls_1080p', '1920x1080', '2M'),
    ]);

    expect(playlist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nhls_360p.m3u8');
    expect(playlist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\nhls_1080p.m3u8');
    expect(playlist.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n')).toBe(true);
  });

  // A private rendition's key carries no `public/` prefix, and the URI must be
  // the same basename either way — the visibility lives in the key, never in the
  // playlist.
  it('is unaffected by the key prefix a private asset would carry', () => {
    const playlist = service.generateMasterPlaylist([
      { resolution: '640x360', bitrate: '500k', playlist: `variants/2026/09/e8/${SHA}/hls_360p.m3u8` },
    ]);

    expect(uris(playlist)).toEqual(['hls_360p.m3u8']);
  });
});
