/**
 * What a downloaded federated avatar IS, decided from its bytes, and the
 * version of it Oxy stores.
 *
 * Remote hosts routinely mislabel real pictures (`text/plain`,
 * `binary/octet-stream`, even `text/html` from some CDNs), so the declared
 * Content-Type is never trusted — the magic bytes are. Oversized pictures
 * (6–8 MB animated WebP/GIF avatars are common) and formats browsers cannot
 * render are re-encoded rather than dropped.
 */
import sharp from 'sharp';

/** Formats every client renders as-is. */
const WEB_SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/** Longest edge of a re-encoded avatar; avatars render at a few hundred px at most. */
export const NORMALIZED_AVATAR_EDGE_PX = 1024;

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

/**
 * The image type the bytes declare, or null when they are not a raster image.
 * SVG is deliberately not recognised: it is a document, not a picture, and an
 * avatar is served from a public CDN origin.
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buffer.length >= 6 && (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a'))
    return 'image/gif';
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP')
    return 'image/webp';
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  if (buffer.length >= 2 && ascii(buffer, 0, 2) === 'BM') return 'image/bmp';
  if (buffer.length >= 4 && (ascii(buffer, 0, 4) === 'II*\0' || ascii(buffer, 0, 4) === 'MM\0*'))
    return 'image/tiff';
  return null;
}

export type NormalizedAvatar =
  | { ok: true; buffer: Buffer; mime: string; reencoded: boolean }
  | { ok: false; reason: 'not_an_image' | 'undecodable' | 'too_large' };

/**
 * The bytes Oxy stores for a downloaded avatar. A web-safe image within
 * `maxStoredBytes` is kept byte-for-byte; anything larger, or in a format a
 * browser cannot show (HEIC, BMP, TIFF), is decoded — first frame only — and
 * re-encoded as a WebP no larger than {@link NORMALIZED_AVATAR_EDGE_PX}.
 */
export async function normalizeAvatarImage(
  buffer: Buffer,
  maxStoredBytes: number,
): Promise<NormalizedAvatar> {
  const mime = sniffImageMime(buffer);
  if (!mime) return { ok: false, reason: 'not_an_image' };
  if (WEB_SAFE.has(mime) && buffer.length <= maxStoredBytes) {
    return { ok: true, buffer, mime, reencoded: false };
  }
  let output: Buffer;
  try {
    output = await sharp(buffer, { animated: false, failOn: 'error' })
      .rotate()
      .resize(NORMALIZED_AVATAR_EDGE_PX, NORMALIZED_AVATAR_EDGE_PX, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
  if (output.length > maxStoredBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, buffer: output, mime: 'image/webp', reencoded: true };
}
