/**
 * Where an HLS playlist's files live, for the generator, the visibility
 * relocation and the stored-segment repair.
 *
 * A playlist's URIs resolve against the playlist's OWN URL (RFC 8216
 * §4.3.4.2), and a rendition playlist names each segment by the file name ffmpeg
 * gave it (`segment_360p_000.ts`). So a segment is stored next to its playlist
 * under exactly that name, and the playlist is the record of which segments a
 * rendition has: segments are not variant rows.
 */

import { applyPublicPrefix, isPublicKey, stripPublicPrefix } from '../config/cdn';

/** Every URI line of a playlist, in order: the lines that are neither blank nor a `#` tag. */
export function playlistUris(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** The storage key of a file a playlist lists by `uri`: the playlist's sibling. */
export function playlistSiblingKey(playlistKey: string, uri: string): string {
  return playlistKey.slice(0, playlistKey.lastIndexOf('/') + 1) + uri;
}

/** A rendition playlist lists segments; the master lists renditions, which are rows. */
export function isHlsRenditionVariant(variantType: string): boolean {
  return variantType.startsWith('hls_') && variantType !== 'hls_master';
}

/**
 * Where the generator used to store a segment: `<renditionType>_<uri>.ts`
 * (`hls_360p_segment_360p_000.ts.ts`), a name no playlist lists, in either
 * spelling of the playlist's directory — a ladder made public before the
 * relocation copied segments still has them only under the private one. Only
 * the repair reads these.
 */
export function legacySegmentKeys(
  playlistKey: string,
  renditionType: string,
  uri: string,
): string[] {
  const name = `${renditionType}_${uri}.ts`;
  const otherSpelling = isPublicKey(playlistKey)
    ? stripPublicPrefix(playlistKey)
    : applyPublicPrefix(playlistKey);
  return [playlistSiblingKey(playlistKey, name), playlistSiblingKey(otherSpelling, name)];
}
