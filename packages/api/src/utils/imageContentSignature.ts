/**
 * Magic-byte validation for image uploads.
 *
 * Defense-in-depth: a broken client can declare `image/*` while sending bytes
 * that are not actually an image (e.g. a `{uri}` descriptor serialized to
 * "[object Object]" by the browser's FormData). Such payloads are non-empty,
 * so the 0-byte guard misses them, and they get stored as a broken avatar.
 * This validates that content declared as an image really begins with a known
 * image signature before it is persisted.
 *
 * Scope: only enforced when the declared MIME is `image/*`. Non-image uploads
 * (documents, etc.) are out of scope and always pass — this is a
 * sniff-the-known-garbage guard, not an exhaustive allow-list (route/cache
 * allow-lists own which types are permitted at all).
 */

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** True if `buf` starts with `sig` at `offset`. */
function matchesAt(buf: Buffer, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BMP = ASCII('BM');
const GIF87 = ASCII('GIF87a');
const GIF89 = ASCII('GIF89a');
const RIFF = ASCII('RIFF');
const WEBP = ASCII('WEBP');
const FTYP = ASCII('ftyp');
const ICO = [0x00, 0x00, 0x01, 0x00];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a];

/** ISO-BMFF brands that denote an image (`ftyp` box at byte 4). */
const IMAGE_FTYP_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'heif',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

function isIsoBmffImage(buf: Buffer): boolean {
  if (!matchesAt(buf, FTYP, 4)) return false;
  const brand = buf.subarray(8, 12).toString('latin1');
  return IMAGE_FTYP_BRANDS.has(brand);
}

function isSvgContent(buf: Buffer): boolean {
  // Strip an optional UTF-8 BOM, then leading whitespace, then require an
  // XML/SVG opening token. (Whether SVG is permitted at all is governed by the
  // existing allow-lists — this only rejects garbage declared as SVG.)
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const head = buf
    .subarray(start, start + 256)
    .toString('utf8')
    .trimStart()
    .toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg');
}

/**
 * Returns `true` when `buffer` is acceptable for the declared `mime`:
 * - non-`image/*` MIME → always `true` (out of scope here)
 * - `image/*` → `true` only if the bytes start with a recognized image
 *   signature (or, for an unknown `image/*` subtype with no known magic, `true`
 *   so we never reject formats we simply don't have a signature for).
 * An empty buffer declared as an image is rejected.
 */
export function isDeclaredImageContentValid(buffer: Buffer, mime: string): boolean {
  const m = (mime || '').toLowerCase().trim();
  if (!m.startsWith('image/')) return true;
  if (buffer.length === 0) return false;

  if (m === 'image/svg+xml') return isSvgContent(buffer);

  const knownImageSubtype =
    m === 'image/jpeg' ||
    m === 'image/jpg' ||
    m === 'image/pjpeg' ||
    m === 'image/png' ||
    m === 'image/apng' ||
    m === 'image/gif' ||
    m === 'image/bmp' ||
    m === 'image/x-ms-bmp' ||
    m === 'image/webp' ||
    m === 'image/avif' ||
    m === 'image/heic' ||
    m === 'image/heif' ||
    m === 'image/x-icon' ||
    m === 'image/vnd.microsoft.icon' ||
    m === 'image/tiff';

  const matchesAnyImageSignature =
    matchesAt(buffer, JPEG) ||
    matchesAt(buffer, PNG) ||
    matchesAt(buffer, GIF87) ||
    matchesAt(buffer, GIF89) ||
    matchesAt(buffer, BMP) ||
    (matchesAt(buffer, RIFF) && matchesAt(buffer, WEBP, 8)) ||
    isIsoBmffImage(buffer) ||
    matchesAt(buffer, ICO) ||
    matchesAt(buffer, TIFF_LE) ||
    matchesAt(buffer, TIFF_BE);

  if (matchesAnyImageSignature) return true;

  // Known image subtype that failed every signature → reject (this is the
  // garbage case). Unknown image subtype with no signature we recognize → accept.
  return !knownImageSubtype;
}
