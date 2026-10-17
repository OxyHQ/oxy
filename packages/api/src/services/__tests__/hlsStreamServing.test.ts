/**
 * A play session's rendition allow-list, below the route (ADR 0043 stage 4c):
 * the master keeps only the allowed renditions, whatever else it declares, and
 * a rung's key is bound to that rung.
 */

import {
  encryptedRenditionPlaylist,
  renditionContentKey,
  restrictedMasterPlaylist,
} from '../hlsStreamServing';

describe('restrictedMasterPlaylist', () => {
  it('keeps each allowed STREAM-INF with its URI and drops the rest', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
      'hls_360p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080',
      'hls_1080p.m3u8',
      '',
    ].join('\n');
    expect(restrictedMasterPlaylist(master, new Set(['hls_360p.m3u8']))).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
        'hls_360p.m3u8',
        '',
      ].join('\n'),
    );
  });

  it('matches a URI by its basename and drops a tag naming a URI that is not allowed', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio_hi.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="https://cdn.example/x/hls_1080p_iframes.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=70000,CODECS="mp4a.40.2"',
      'https://cdn.example/x/hls_a64.m3u8?v=1',
      '#EXT-X-STREAM-INF:BANDWIDTH=265000,CODECS="mp4a.40.2"',
      'hls_a256.m3u8',
    ].join('\n');
    const out = restrictedMasterPlaylist(master, new Set(['hls_a64.m3u8']));
    expect(out).toContain('https://cdn.example/x/hls_a64.m3u8?v=1');
    expect(out).not.toContain('hls_a256');
    expect(out).not.toContain('audio_hi');
    expect(out).not.toContain('iframes');
    expect(out.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
  });

  it('lists nothing when nothing is allowed', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhls_a64.m3u8\n';
    expect(restrictedMasterPlaylist(master, new Set())).toBe('#EXTM3U\n');
  });
});

describe('a rung’s key', () => {
  it('is deterministic per session and rung, and differs from the session key and other rungs', () => {
    const sessionKey = Buffer.alloc(16, 7);
    const a64 = renditionContentKey(sessionKey, 'hls_a64');
    expect(a64).toHaveLength(16);
    expect(renditionContentKey(sessionKey, 'hls_a64').equals(a64)).toBe(true);
    expect(renditionContentKey(sessionKey, 'hls_a128').equals(a64)).toBe(false);
    expect(renditionContentKey(Buffer.alloc(16, 8), 'hls_a64').equals(a64)).toBe(false);
    expect(a64.equals(sessionKey)).toBe(false);
  });

  it('is named in the rung’s playlist when the session has a list', () => {
    const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nsegment_a64_000.ts\n';
    expect(encryptedRenditionPlaylist(playlist, 'hls_a64.key')).toContain(
      '#EXT-X-KEY:METHOD=AES-128,URI="hls_a64.key"\n#EXTINF:6.0,',
    );
    expect(encryptedRenditionPlaylist(playlist)).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key"');
  });
});
