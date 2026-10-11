import { isDeclaredImageContentValid } from '../imageContentSignature';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = Buffer.from('GIF89a-rest', 'latin1');
const bmp = Buffer.from('BM......', 'latin1');
const webp = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
]);
const avif = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypavif', 'latin1')]);
const garbage = Buffer.from('[object Object]', 'utf8');

describe('isDeclaredImageContentValid', () => {
  it('rejects non-image content declared as an image (the broken-upload case)', () => {
    expect(isDeclaredImageContentValid(garbage, 'image/png')).toBe(false);
    expect(isDeclaredImageContentValid(garbage, 'image/jpeg')).toBe(false);
    expect(isDeclaredImageContentValid(Buffer.from('not a webp'), 'image/webp')).toBe(false);
  });

  it('rejects an empty buffer declared as an image', () => {
    expect(isDeclaredImageContentValid(Buffer.alloc(0), 'image/png')).toBe(false);
  });

  it('accepts real image content matching the declared type', () => {
    expect(isDeclaredImageContentValid(png, 'image/png')).toBe(true);
    expect(isDeclaredImageContentValid(jpeg, 'image/jpeg')).toBe(true);
    expect(isDeclaredImageContentValid(gif, 'image/gif')).toBe(true);
    expect(isDeclaredImageContentValid(bmp, 'image/bmp')).toBe(true);
    expect(isDeclaredImageContentValid(webp, 'image/webp')).toBe(true);
    expect(isDeclaredImageContentValid(avif, 'image/avif')).toBe(true);
  });

  it('validates SVG structurally', () => {
    expect(isDeclaredImageContentValid(Buffer.from('<svg xmlns="...">'), 'image/svg+xml')).toBe(
      true,
    );
    expect(
      isDeclaredImageContentValid(Buffer.from('  <?xml version="1.0"?><svg/>'), 'image/svg+xml'),
    ).toBe(true);
    expect(isDeclaredImageContentValid(garbage, 'image/svg+xml')).toBe(false);
  });

  it('never rejects non-image uploads (out of scope)', () => {
    expect(isDeclaredImageContentValid(garbage, 'application/pdf')).toBe(true);
    expect(isDeclaredImageContentValid(Buffer.from('text'), 'text/plain')).toBe(true);
    expect(isDeclaredImageContentValid(garbage, '')).toBe(true);
  });

  it('accepts unknown image subtypes with no known signature (sniff-known-garbage, not allow-list)', () => {
    expect(isDeclaredImageContentValid(Buffer.from('whatever'), 'image/x-unknown-format')).toBe(
      true,
    );
  });
});
