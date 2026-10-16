/**
 * Serving a file's HLS ladder through a play session (ADR 0043 stage 4c):
 * which stored object a session URL names, the rendition playlists rewritten
 * for AES-128, and segments encrypted as they are served.
 *
 * The ladder is stored once, in clear (`variantService`): a master playlist
 * listing rendition playlists by basename, each listing its segments by
 * basename, all in one directory (`hlsPlaylist.ts`). A session's URLs mirror
 * that directory — `/assets/streams/<token>/<basename>` — so every relative URI
 * a player resolves lands back here, and only names the ladder itself lists are
 * served: a URL can never reach another object.
 *
 * ## AES-128 (RFC 8216 §5.2)
 *
 * For an encrypted session each rendition playlist gets
 * `#EXT-X-KEY:METHOD=AES-128,URI="key"` before its first segment, with no IV
 * attribute, so a segment's IV is its media sequence number as a 128-bit
 * big-endian integer. A segment is encrypted on the way out: AES-128-CBC with
 * PKCS#7 padding under the session's own key, over the whole stored segment
 * (no byte ranges). The key is served at `<token>/key` only to a valid session,
 * and with key authorization only after the application allows it.
 */

import crypto from 'node:crypto';
import type { FileRecord, FileVariantRecord } from '../types/file.types';
import { playlistSiblingKey, playlistUris } from './hlsPlaylist';

/** A basename a session URL may name. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const MASTER_PLAYLIST_NAME = 'master.m3u8';
export const KEY_NAME = 'key';
export const PREVIEW_NAME = 'preview.m4a';
export const WAVEFORM_NAME = 'waveform.json';

/** What a session URL's last segment names. */
export type StreamObject =
  | { kind: 'master'; variant: FileVariantRecord }
  | { kind: 'rendition'; variant: FileVariantRecord }
  | { kind: 'segment'; key: string; mediaSequence: number }
  | { kind: 'key' }
  | { kind: 'preview'; variant: FileVariantRecord }
  | { kind: 'waveform'; variant: FileVariantRecord };

function basename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** The ready rendition playlists of a file's ladder (every `hls_*` but the master). */
export function readyRenditions(file: FileRecord): FileVariantRecord[] {
  return file.variants.filter(
    (variant) =>
      variant.type.startsWith('hls_') &&
      variant.type !== 'hls_master' &&
      variant.readyAt !== null &&
      variant.key.endsWith('.m3u8'),
  );
}

function readyVariant(file: FileRecord, type: string): FileVariantRecord | undefined {
  return file.variants.find((variant) => variant.type === type && variant.readyAt !== null);
}

/** A parsed media playlist: its segment URIs and first media sequence number. */
export interface ParsedPlaylist {
  text: string;
  uris: string[];
  mediaSequence: number;
}

export function parsePlaylist(text: string): ParsedPlaylist {
  const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m.exec(text);
  return { text, uris: playlistUris(text), mediaSequence: match ? Number(match[1]) : 0 };
}

/** Reads a stored playlist (immutable, content-addressed): cached per task. */
export type PlaylistReader = (key: string) => Promise<ParsedPlaylist>;

const PLAYLIST_CACHE_MAX = 2_000;
const playlistCache = new Map<string, ParsedPlaylist>();

/** A {@link PlaylistReader} over `download`, with an LRU of parsed playlists. */
export function cachedPlaylistReader(download: (key: string) => Promise<Buffer>): PlaylistReader {
  return async (key) => {
    const hit = playlistCache.get(key);
    if (hit) {
      playlistCache.delete(key);
      playlistCache.set(key, hit);
      return hit;
    }
    const parsed = parsePlaylist((await download(key)).toString('utf8'));
    playlistCache.set(key, parsed);
    while (playlistCache.size > PLAYLIST_CACHE_MAX) {
      const oldest = playlistCache.keys().next().value;
      if (oldest === undefined) break;
      playlistCache.delete(oldest);
    }
    return parsed;
  };
}

/**
 * What `name` names in `file`'s ladder, or `null`. A segment must be listed by
 * one of the ready rendition playlists; its media sequence number is its
 * position there (plus the playlist's `EXT-X-MEDIA-SEQUENCE`).
 */
export async function resolveStreamObject(
  file: FileRecord,
  name: string,
  readPlaylist: PlaylistReader,
): Promise<StreamObject | null> {
  if (!NAME_PATTERN.test(name) || name.includes('..')) return null;
  if (name === KEY_NAME) return { kind: 'key' };
  if (name === MASTER_PLAYLIST_NAME) {
    const variant = readyVariant(file, 'hls_master');
    return variant ? { kind: 'master', variant } : null;
  }
  if (name === PREVIEW_NAME) {
    const variant = readyVariant(file, 'preview');
    return variant ? { kind: 'preview', variant } : null;
  }
  if (name === WAVEFORM_NAME) {
    const variant = readyVariant(file, 'waveform');
    return variant ? { kind: 'waveform', variant } : null;
  }
  const renditions = readyRenditions(file);
  if (name.endsWith('.m3u8')) {
    const variant = renditions.find((candidate) => basename(candidate.key) === name);
    return variant ? { kind: 'rendition', variant } : null;
  }
  for (const rendition of renditions) {
    const playlist = await readPlaylist(rendition.key);
    const index = playlist.uris.indexOf(name);
    if (index >= 0) {
      return {
        kind: 'segment',
        key: playlistSiblingKey(rendition.key, name),
        mediaSequence: playlist.mediaSequence + index,
      };
    }
  }
  return null;
}

/** The tag an encrypted session's rendition playlists carry; the URI is the session's own `key`. */
export const AES_KEY_TAG = `#EXT-X-KEY:METHOD=AES-128,URI="${KEY_NAME}"`;

/**
 * A rendition playlist as an encrypted session serves it: the key tag before
 * the first segment. A playlist that already declares a key is refused (it is
 * not one this service produced).
 */
export function encryptedRenditionPlaylist(text: string): string {
  if (/^#EXT-X-KEY:/m.test(text)) {
    throw new Error('The stored playlist already declares a key');
  }
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith('#EXTINF'));
  if (first < 0) return text;
  lines.splice(first, 0, AES_KEY_TAG);
  return lines.join('\n');
}

/** The IV of segment `mediaSequence`: the number as a 128-bit big-endian integer. */
export function segmentIv(mediaSequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(mediaSequence), 8);
  return iv;
}

/** A cipher that encrypts one segment for the session's key. */
export function segmentCipher(key: Buffer, mediaSequence: number): crypto.Cipher {
  return crypto.createCipheriv('aes-128-cbc', key, segmentIv(mediaSequence));
}

/** The size of `plainLength` bytes after AES-CBC with PKCS#7 padding. */
export function encryptedLength(plainLength: number): number {
  return (Math.floor(plainLength / 16) + 1) * 16;
}

/** The content type a session serves `object` with. */
export function streamContentType(object: StreamObject, storedType?: string): string {
  switch (object.kind) {
    case 'master':
    case 'rendition':
      return 'application/vnd.apple.mpegurl';
    case 'key':
      return 'application/octet-stream';
    case 'waveform':
      return 'application/json';
    case 'preview':
      return 'audio/mp4';
    case 'segment':
      return storedType && storedType !== 'application/octet-stream' ? storedType : 'video/mp2t';
  }
}
