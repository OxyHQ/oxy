/**
 * The stored-master repair's transform.
 *
 * Every HLS master this service wrote lists its renditions by S3 storage key,
 * and a master's URIs resolve against the MASTER's own URL (RFC 8216 §4.3.4.2),
 * so a player 403s on every quality. The generator is fixed; masters already in
 * S3 are only rewritten when a variant set is rebuilt, so they need this pass.
 *
 * The assertions are about RESOLUTION where it matters — the same property the
 * generator's test checks — plus the two properties a repair pass needs that a
 * generator does not: it must be idempotent, and it must not turn a master with
 * no renditions into one that merely looks repaired.
 */

import { rewriteMasterPlaylist } from '../hlsMasterPlaylistRewrite';

const SHA = 'e80e2cc4c0d81707301d5d3064299cbaf2884eaf03fb1aa54803a70c956d957a';
const MASTER_URL = `https://cloud.oxy.so/variants/2026/09/e8/${SHA}/hls_master.m3u8`;

const BROKEN = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
  `public/variants/2026/09/e8/${SHA}/hls_360p.m3u8`,
  '',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
  `public/variants/2026/09/e8/${SHA}/hls_720p.m3u8`,
  '',
].join('\n');

describe('rewriteMasterPlaylist', () => {
  it('rewrites each URI to the rendition beside the master', () => {
    const { playlist, uriLines } = rewriteMasterPlaylist(BROKEN);

    expect(uriLines).toBe(2);
    const uris = playlist
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(uris).toEqual(['hls_360p.m3u8', 'hls_720p.m3u8']);
    expect(new URL(uris[0], MASTER_URL).toString()).toBe(
      `https://cloud.oxy.so/variants/2026/09/e8/${SHA}/hls_360p.m3u8`,
    );
  });

  it('keeps every tag, blank line and the ordering', () => {
    const { playlist } = rewriteMasterPlaylist(BROKEN);

    expect(playlist).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '',
        '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
        'hls_360p.m3u8',
        '',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
        'hls_720p.m3u8',
        '',
      ].join('\n'),
    );
  });

  // The pass has to be safe to re-run: it walks every ready master, including
  // the ones a previous run (or the fixed generator) already left correct.
  it('is idempotent — a repaired master comes back byte-identical', () => {
    const once = rewriteMasterPlaylist(BROKEN).playlist;
    const twice = rewriteMasterPlaylist(once).playlist;

    expect(twice).toBe(once);
  });

  // A master with no renditions is a DIFFERENT defect (the generator resolves
  // without one when the last rendition to finish fails). Reporting it is the
  // point; rewriting it to itself would hide it in the "already correct" count.
  it('reports a master that lists no renditions instead of repairing it', () => {
    const { playlist, uriLines } = rewriteMasterPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n');

    expect(uriLines).toBe(0);
    expect(playlist).toBe('#EXTM3U\n#EXT-X-VERSION:3\n');
  });
});
