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
 *
 * ## A rendition allow-list
 *
 * A session may be limited to some rungs of the ladder (`renditions`, e.g. a
 * free listener's `hls_a64` and `hls_a128`). Then the master lists only those
 * rungs, and every OTHER rung's playlist, segments and key resolve to nothing
 * — the session cannot serve them however its URL is edited. Such a session
 * has one key PER RUNG, derived from its content key
 * ({@link renditionContentKey}) and served at `<token>/<rung>.key`; each rung's
 * playlist names its own, its segments are encrypted under it, and the
 * session's own key (`<token>/key`), from which every rung's derives, is never
 * served. So even a segment of another rung obtained some other way would not
 * open with a key the session hands out.
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

/** The suffix of a rung's own key in a session limited to some rungs: `hls_a64.key`. */
export const RENDITION_KEY_SUFFIX = '.key';

/**
 * The rungs a session may serve: `null` for the whole ladder, else the
 * variant types of its allow-list.
 */
export type RenditionAllowList = ReadonlySet<string> | null;

/** What a session URL's last segment names. */
export type StreamObject =
  | { kind: 'master'; variant: FileVariantRecord }
  | { kind: 'rendition'; variant: FileVariantRecord }
  | { kind: 'segment'; key: string; mediaSequence: number; rendition: string }
  /** The session's key (`rendition` null), or one rung's key in a session limited to some rungs. */
  | { kind: 'key'; rendition: string | null }
  | { kind: 'preview'; variant: FileVariantRecord }
  | { kind: 'waveform'; variant: FileVariantRecord };

function basename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/**
 * The ready rendition playlists of a file's ladder (every `hls_*` but the
 * master) — only the allowed ones when the session has an allow-list.
 */
export function readyRenditions(
  file: FileRecord,
  allowed: RenditionAllowList = null,
): FileVariantRecord[] {
  return file.variants.filter(
    (variant) =>
      variant.type.startsWith('hls_') &&
      variant.type !== 'hls_master' &&
      variant.readyAt !== null &&
      variant.key.endsWith('.m3u8') &&
      (allowed === null || allowed.has(variant.type)),
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
  allowed: RenditionAllowList = null,
): Promise<StreamObject | null> {
  if (!NAME_PATTERN.test(name) || name.includes('..')) return null;
  const renditions = readyRenditions(file, allowed);
  // A session limited to some rungs serves each rung's key, never its own.
  if (name === KEY_NAME) return allowed === null ? { kind: 'key', rendition: null } : null;
  if (name.endsWith(RENDITION_KEY_SUFFIX)) {
    if (allowed === null) return null;
    const type = name.slice(0, -RENDITION_KEY_SUFFIX.length);
    return renditions.some((variant) => variant.type === type)
      ? { kind: 'key', rendition: type }
      : null;
  }
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
        rendition: rendition.type,
      };
    }
  }
  return null;
}

/** The tag an encrypted session's rendition playlists carry; the URI is the session's own `key`. */
export const AES_KEY_TAG = aesKeyTag(KEY_NAME);

function aesKeyTag(uri: string): string {
  return `#EXT-X-KEY:METHOD=AES-128,URI="${uri}"`;
}

/** The name of rung `type`'s own key in a session limited to some rungs. */
export function renditionKeyName(type: string): string {
  return `${type}${RENDITION_KEY_SUFFIX}`;
}

/**
 * A rendition playlist as an encrypted session serves it: the key tag before
 * the first segment — the session's `key`, or `keyUri` (a rung's own key). A
 * playlist that already declares a key is refused (it is not one this service
 * produced).
 */
export function encryptedRenditionPlaylist(text: string, keyUri: string = KEY_NAME): string {
  if (/^#EXT-X-KEY:/m.test(text)) {
    throw new Error('The stored playlist already declares a key');
  }
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith('#EXTINF'));
  if (first < 0) return text;
  lines.splice(first, 0, aesKeyTag(keyUri));
  return lines.join('\n');
}

function uriBasename(uri: string): string {
  const path = uri.split(/[?#]/, 1)[0];
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * A master playlist with only the renditions named in `allowedNames` (their
 * playlist basenames): each `#EXT-X-STREAM-INF` goes with the URI it
 * describes, and a tag that names a URI itself (`#EXT-X-MEDIA`,
 * `#EXT-X-I-FRAME-STREAM-INF`) stays only when that URI is allowed.
 */
export function restrictedMasterPlaylist(text: string, allowedNames: ReadonlySet<string>): string {
  const out: string[] = [];
  let pending: string[] | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      pending = [line];
      continue;
    }
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      if (allowedNames.has(uriBasename(trimmed))) out.push(...(pending ?? []), line);
      pending = null;
      continue;
    }
    const tagUri = /URI="([^"]*)"/.exec(trimmed);
    if (tagUri && !allowedNames.has(uriBasename(tagUri[1]))) continue;
    if (pending) pending.push(line);
    else out.push(line);
  }
  return out.join('\n');
}

/**
 * Rung `type`'s own content key in a session limited to some rungs: HKDF-SHA256
 * of the session's key, bound to the rung. One rung's key opens no other's
 * segments, and none of them yields the session's key.
 */
export function renditionContentKey(sessionKey: Buffer, type: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      sessionKey,
      Buffer.alloc(0),
      `oxy-play-session-rendition|${type}`,
      16,
    ),
  );
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
