/**
 * Windows icon (`.ico`) and cursor (`.cur`) containers, made decodable.
 *
 * libvips — and so sharp — has no ICO loader: handed an icon it throws "Input
 * buffer contains unsupported image format", and every rendition of the file
 * (and the queue's three attempts) fails with it. Favicons are a large share of
 * what applications store (Clarity keeps every site's), so the pipeline decodes
 * the container itself and hands sharp the one image it should render: the
 * LARGEST frame, the one that downsizes best to every rendition.
 *
 * An ICO is a directory of frames, each either a PNG (stored whole, which sharp
 * reads) or a headerless BMP: a BITMAPINFOHEADER, an optional palette, the
 * colour bitmap (XOR mask) and a 1-bit transparency bitmap (AND mask), both
 * bottom-up with rows padded to 4 bytes, under a header whose height counts
 * both masks. Frame sizes are read from each frame's own header, not from the
 * directory: a directory byte of 0 means 256 and writers routinely get it wrong.
 */

const ICO_HEADER_BYTES = 6;
const ICO_DIRECTORY_ENTRY_BYTES = 16;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BI_RGB = 0;
const BI_BITFIELDS = 3;
/** Nothing larger is a real icon; a bigger header is a hostile or broken file. */
const MAX_FRAME_DIMENSION = 4096;

/** An icon that names no frame this decoder can render. */
export class UndecodableIconError extends Error {
  constructor(message: string) {
    super(`Undecodable icon: ${message}`);
    this.name = 'UndecodableIconError';
  }
}

/** The largest frame: a PNG sharp reads as is, or decoded pixels for sharp's raw input. */
export type IconFrame =
  | { kind: 'png'; data: Buffer; width: number; height: number }
  | { kind: 'rgba'; data: Buffer; width: number; height: number };

interface FrameRef {
  offset: number;
  size: number;
  width: number;
  height: number;
  bitCount: number;
  png: boolean;
}

/**
 * Whether `buffer` is an ICO or CUR container, by its header — never by the
 * declared mime, which arrives as `image/x-icon`, `image/vnd.microsoft.icon`,
 * `image/icon` and sometimes on a PNG.
 */
export function isIconContainer(buffer: Buffer): boolean {
  if (buffer.length < ICO_HEADER_BYTES + ICO_DIRECTORY_ENTRY_BYTES) return false;
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  return (
    reserved === 0 &&
    (type === 1 || type === 2) &&
    count > 0 &&
    buffer.length >= ICO_HEADER_BYTES + count * ICO_DIRECTORY_ENTRY_BYTES
  );
}

function pngDimensions(frame: Buffer): { width: number; height: number } | null {
  // Signature, then the IHDR chunk: length, "IHDR", width, height.
  if (frame.length < 24 || !frame.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (frame.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: frame.readUInt32BE(16), height: frame.readUInt32BE(20) };
}

function frameRefs(buffer: Buffer): FrameRef[] {
  const count = buffer.readUInt16LE(4);
  const refs: FrameRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = ICO_HEADER_BYTES + index * ICO_DIRECTORY_ENTRY_BYTES;
    const size = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    if (size === 0 || offset < ICO_HEADER_BYTES || offset + size > buffer.length) continue;
    const frame = buffer.subarray(offset, offset + size);
    const png = pngDimensions(frame);
    if (png) {
      refs.push({ offset, size, ...png, bitCount: 32, png: true });
      continue;
    }
    if (frame.length < 40) continue;
    const headerSize = frame.readUInt32LE(0);
    if (headerSize < 40 || headerSize > frame.length) continue;
    const width = frame.readInt32LE(4);
    // The header's height covers the colour bitmap AND the mask.
    const height = Math.abs(frame.readInt32LE(8)) / 2;
    refs.push({
      offset,
      size,
      width,
      height,
      bitCount: frame.readUInt16LE(14),
      png: false,
    });
  }
  return refs.filter(
    (ref) =>
      Number.isInteger(ref.width) &&
      Number.isInteger(ref.height) &&
      ref.width > 0 &&
      ref.height > 0 &&
      ref.width <= MAX_FRAME_DIMENSION &&
      ref.height <= MAX_FRAME_DIMENSION,
  );
}

function stride(width: number, bitCount: number): number {
  return Math.ceil((width * bitCount) / 32) * 4;
}

/** A headerless BMP frame to top-down RGBA. */
function decodeBmpFrame(frame: Buffer, width: number, height: number): Buffer {
  const headerSize = frame.readUInt32LE(0);
  const topDown = frame.readInt32LE(8) < 0;
  const bitCount = frame.readUInt16LE(14);
  const compression = frame.readUInt32LE(16);
  if (compression !== BI_RGB && !(compression === BI_BITFIELDS && bitCount === 32)) {
    throw new UndecodableIconError(`BMP compression ${compression} is not supported`);
  }
  if (![1, 4, 8, 24, 32].includes(bitCount)) {
    throw new UndecodableIconError(`BMP bit depth ${bitCount} is not supported`);
  }

  // BI_BITFIELDS keeps three masks after a 40-byte header; 32-bit icons that
  // use them always use the standard BGRA layout, which is decoded below.
  let cursor = headerSize + (compression === BI_BITFIELDS && headerSize === 40 ? 12 : 0);
  let palette: Buffer | null = null;
  if (bitCount <= 8) {
    const used = frame.readUInt32LE(32);
    const colours = used > 0 && used <= 1 << bitCount ? used : 1 << bitCount;
    palette = frame.subarray(cursor, cursor + colours * 4);
    if (palette.length < colours * 4) throw new UndecodableIconError('palette is truncated');
    cursor += colours * 4;
  }

  const xorStride = stride(width, bitCount);
  const andStride = stride(width, 1);
  const xorBytes = xorStride * height;
  const xor = frame.subarray(cursor, cursor + xorBytes);
  if (xor.length < xorBytes) throw new UndecodableIconError('colour bitmap is truncated');
  // The AND mask is optional in practice for 32-bit frames (alpha carries it).
  const and = frame.subarray(cursor + xorBytes, cursor + xorBytes + andStride * height);
  const hasMask = and.length >= andStride * height;

  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const sourceRow = topDown ? y : height - 1 - y;
    const row = sourceRow * xorStride;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let b: number;
      let g: number;
      let r: number;
      let a = 255;
      if (bitCount === 32) {
        b = xor[row + x * 4];
        g = xor[row + x * 4 + 1];
        r = xor[row + x * 4 + 2];
        a = xor[row + x * 4 + 3];
        if (a !== 0) anyAlpha = true;
      } else if (bitCount === 24) {
        b = xor[row + x * 3];
        g = xor[row + x * 3 + 1];
        r = xor[row + x * 3 + 2];
      } else {
        const perByte = 8 / bitCount;
        const byte = xor[row + Math.floor(x / perByte)];
        const shift = 8 - bitCount * ((x % perByte) + 1);
        const index = (byte >> shift) & ((1 << bitCount) - 1);
        const entry = (palette as Buffer).subarray(index * 4, index * 4 + 4);
        b = entry[0] ?? 0;
        g = entry[1] ?? 0;
        r = entry[2] ?? 0;
      }
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }

  // Transparency: a 32-bit frame's alpha channel when it has one; otherwise
  // the AND mask, where a set bit is a transparent pixel.
  if ((bitCount !== 32 || !anyAlpha) && hasMask) {
    for (let y = 0; y < height; y += 1) {
      const sourceRow = topDown ? y : height - 1 - y;
      const row = sourceRow * andStride;
      for (let x = 0; x < width; x += 1) {
        const transparent = (and[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  } else if (bitCount === 32 && !anyAlpha) {
    for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  }
  return rgba;
}

/**
 * The container's largest frame — most pixels, then the deepest colour — as
 * something sharp reads. Throws {@link UndecodableIconError} when no frame is
 * usable; the caller treats that as an image with no renditions.
 */
export function largestIconFrame(buffer: Buffer): IconFrame {
  if (!isIconContainer(buffer)) throw new UndecodableIconError('not an ICO/CUR container');
  const refs = frameRefs(buffer).sort(
    (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount,
  );
  const failures: string[] = [];
  // The largest frame that decodes; a broken big frame falls back to the next.
  for (const ref of refs) {
    const frame = buffer.subarray(ref.offset, ref.offset + ref.size);
    if (ref.png) return { kind: 'png', data: frame, width: ref.width, height: ref.height };
    try {
      return {
        kind: 'rgba',
        data: decodeBmpFrame(frame, ref.width, ref.height),
        width: ref.width,
        height: ref.height,
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new UndecodableIconError(
    failures.length > 0 ? failures.join('; ') : 'the directory names no usable frame',
  );
}
