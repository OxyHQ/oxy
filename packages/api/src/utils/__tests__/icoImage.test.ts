import sharp from 'sharp';
import { UndecodableIconError, isIconContainer, largestIconFrame } from '../icoImage';

interface Frame {
  /** The frame's bytes as stored in the container. */
  data: Buffer;
  /** The directory's claim (0 = 256); deliberately allowed to disagree with the frame. */
  directoryWidth: number;
  directoryHeight: number;
  bitCount: number;
}

/** An ICO container of `frames`, in order. */
function ico(frames: Frame[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(16 * frames.length);
  let offset = 6 + directory.length;
  frames.forEach((frame, index) => {
    const entry = index * 16;
    directory.writeUInt8(frame.directoryWidth & 0xff, entry);
    directory.writeUInt8(frame.directoryHeight & 0xff, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(frame.bitCount, entry + 6);
    directory.writeUInt32LE(frame.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  });
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)]);
}

const rowBytes = (width: number, bitCount: number) => Math.ceil((width * bitCount) / 32) * 4;

/**
 * A headerless BMP frame: BITMAPINFOHEADER (height doubled), palette, the
 * bottom-up colour rows and the bottom-up AND mask. `pixel(x, y)` is in
 * top-down coordinates and returns a palette index (≤ 8 bits) or [r, g, b, a].
 */
function bmpFrame(
  width: number,
  height: number,
  bitCount: 1 | 4 | 8 | 24 | 32,
  pixel: (x: number, y: number) => number | [number, number, number, number],
  options: {
    palette?: Array<[number, number, number]>;
    transparent?: (x: number, y: number) => boolean;
  } = {},
): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(bitCount, 14);
  const palette = Buffer.alloc((options.palette?.length ?? 0) * 4);
  options.palette?.forEach(([r, g, b], index) => {
    palette[index * 4] = b;
    palette[index * 4 + 1] = g;
    palette[index * 4 + 2] = r;
  });
  if (options.palette) header.writeUInt32LE(options.palette.length, 32);

  const xorStride = rowBytes(width, bitCount);
  const xor = Buffer.alloc(xorStride * height);
  const andStride = rowBytes(width, 1);
  const and = Buffer.alloc(andStride * height);
  for (let y = 0; y < height; y += 1) {
    const row = (height - 1 - y) * xorStride;
    const maskRow = (height - 1 - y) * andStride;
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y);
      if (Array.isArray(value)) {
        const [r, g, b, a] = value;
        const at = row + x * (bitCount / 8);
        xor[at] = b;
        xor[at + 1] = g;
        xor[at + 2] = r;
        if (bitCount === 32) xor[at + 3] = a;
      } else {
        const perByte = 8 / bitCount;
        const shift = 8 - bitCount * ((x % perByte) + 1);
        xor[row + Math.floor(x / perByte)] |= value << shift;
      }
      if (options.transparent?.(x, y)) and[maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, palette, xor, and]);
}

function rgbaAt(frame: { data: Buffer; width: number }, x: number, y: number): number[] {
  const at = (y * frame.width + x) * 4;
  return [...frame.data.subarray(at, at + 4)];
}

describe('isIconContainer', () => {
  it('recognises an icon by its header, whatever it was declared as', async () => {
    const icon = ico([
      {
        data: bmpFrame(2, 2, 32, () => [1, 2, 3, 255]),
        directoryWidth: 2,
        directoryHeight: 2,
        bitCount: 32,
      },
    ]);
    expect(isIconContainer(icon)).toBe(true);
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    expect(isIconContainer(png)).toBe(false);
    expect(isIconContainer(Buffer.alloc(0))).toBe(false);
    // A header naming more directory entries than the bytes hold.
    expect(isIconContainer(Buffer.from([0, 0, 1, 0, 9, 0, ...Array(16).fill(0)]))).toBe(false);
  });
});

describe('largestIconFrame', () => {
  it('picks the frame with the most pixels, read from the frame and not the directory', async () => {
    const small = bmpFrame(16, 16, 32, () => [255, 0, 0, 255]);
    const large = bmpFrame(48, 48, 32, () => [0, 0, 255, 255]);
    // The directory lies: it calls the 48-pixel frame 1×1 and the small one 0 (= 256).
    const icon = ico([
      { data: small, directoryWidth: 0, directoryHeight: 0, bitCount: 32 },
      { data: large, directoryWidth: 1, directoryHeight: 1, bitCount: 32 },
    ]);

    const frame = largestIconFrame(icon);

    expect(frame.kind).toBe('rgba');
    expect([frame.width, frame.height]).toEqual([48, 48]);
    expect(rgbaAt(frame, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('hands a PNG frame over whole, and prefers it when it is the largest', async () => {
    const png = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 0, g: 128, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const icon = ico([
      {
        data: bmpFrame(32, 32, 32, () => [9, 9, 9, 255]),
        directoryWidth: 32,
        directoryHeight: 32,
        bitCount: 32,
      },
      { data: png, directoryWidth: 0, directoryHeight: 0, bitCount: 32 },
    ]);

    const frame = largestIconFrame(icon);

    expect(frame.kind).toBe('png');
    expect(frame.data.equals(png)).toBe(true);
    expect([frame.width, frame.height]).toEqual([256, 256]);
  });

  it('decodes a 32-bit frame top-down, keeping its alpha channel', () => {
    const icon = ico([
      {
        data: bmpFrame(3, 2, 32, (x, y) => (y === 0 ? [x * 100, 0, 0, 255] : [0, 0, 0, 0])),
        directoryWidth: 3,
        directoryHeight: 2,
        bitCount: 32,
      },
    ]);

    const frame = largestIconFrame(icon);

    expect(rgbaAt(frame, 2, 0)).toEqual([200, 0, 0, 255]);
    expect(rgbaAt(frame, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('takes transparency from the AND mask for a 24-bit frame', () => {
    const icon = ico([
      {
        data: bmpFrame(5, 3, 24, () => [10, 20, 30, 0], { transparent: (x) => x === 4 }),
        directoryWidth: 5,
        directoryHeight: 3,
        bitCount: 24,
      },
    ]);

    const frame = largestIconFrame(icon);

    expect(rgbaAt(frame, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(rgbaAt(frame, 4, 2)).toEqual([10, 20, 30, 0]);
  });

  it('decodes paletted 8-, 4- and 1-bit frames', () => {
    const palette: Array<[number, number, number]> = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 0, 255],
    ];
    for (const bitCount of [8, 4] as const) {
      const icon = ico([
        {
          data: bmpFrame(7, 2, bitCount, (x) => x % 4, { palette }),
          directoryWidth: 7,
          directoryHeight: 2,
          bitCount,
        },
      ]);
      const frame = largestIconFrame(icon);
      expect(rgbaAt(frame, 2, 1)).toEqual([255, 0, 0, 255]);
      expect(rgbaAt(frame, 3, 0)).toEqual([0, 0, 255, 255]);
    }
    const mono = ico([
      {
        data: bmpFrame(9, 1, 1, (x) => x % 2, {
          palette: palette.slice(0, 2),
          transparent: (x) => x === 8,
        }),
        directoryWidth: 9,
        directoryHeight: 1,
        bitCount: 1,
      },
    ]);
    const frame = largestIconFrame(mono);
    expect(rgbaAt(frame, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(rgbaAt(frame, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(rgbaAt(frame, 8, 0)[3]).toBe(0);
  });

  it('falls back to the next frame when the largest is truncated', () => {
    const broken = bmpFrame(64, 64, 32, () => [1, 1, 1, 255]).subarray(0, 200);
    const icon = ico([
      { data: broken, directoryWidth: 64, directoryHeight: 64, bitCount: 32 },
      {
        data: bmpFrame(16, 16, 32, () => [7, 7, 7, 255]),
        directoryWidth: 16,
        directoryHeight: 16,
        bitCount: 32,
      },
    ]);

    const frame = largestIconFrame(icon);

    expect([frame.width, frame.height]).toEqual([16, 16]);
  });

  it('refuses a container with no usable frame, and anything that is not one', () => {
    const header = bmpFrame(16, 16, 32, () => [0, 0, 0, 255]).subarray(0, 40);
    expect(() =>
      largestIconFrame(
        ico([{ data: header, directoryWidth: 16, directoryHeight: 16, bitCount: 32 }]),
      ),
    ).toThrow(UndecodableIconError);
    expect(() => largestIconFrame(Buffer.from('not an icon at all, just text'))).toThrow(
      UndecodableIconError,
    );
  });
});
