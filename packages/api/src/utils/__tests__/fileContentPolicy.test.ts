/**
 * What a large upload may store and how a file is served (ADR 0041 stage 4b,
 * `utils/fileContentPolicy.ts`).
 */

import {
  contentDispositionFor,
  fileNameExtension,
  isDeniedUploadType,
  isInlineServableType,
  LARGE_UPLOAD_MAX_BYTES,
  LARGE_UPLOAD_MAX_PARTS,
  largeUploadPartSize,
  normalizeContentType,
  storedExtensionFor,
} from '../fileContentPolicy';

describe('normalizeContentType', () => {
  it('lowercases and drops parameters; refuses what is not type/subtype', () => {
    expect(normalizeContentType('Text/Plain; charset=UTF-8')).toBe('text/plain');
    expect(normalizeContentType('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
    expect(normalizeContentType('not a type')).toBeNull();
    expect(normalizeContentType('image/')).toBeNull();
    expect(normalizeContentType('')).toBeNull();
  });
});

describe('isDeniedUploadType', () => {
  it.each([
    ['text/html'],
    ['application/xhtml+xml'],
    ['image/svg+xml'],
    ['application/javascript'],
    ['text/xml'],
    ['application/x-msdownload'],
    ['application/vnd.android.package-archive'],
    ['application/x-sh'],
  ])('refuses %s', (type) => {
    expect(isDeniedUploadType(type)).toBe(true);
  });

  it('refuses a denied extension under any declared type, case-insensitively', () => {
    expect(isDeniedUploadType('application/octet-stream', 'Setup.EXE')).toBe(true);
    expect(isDeniedUploadType('application/zip', 'page.html')).toBe(true);
    expect(isDeniedUploadType('text/plain', 'run.sh')).toBe(true);
  });

  it.each([
    ['application/zip', 'catalogue.zip'],
    ['application/pdf', 'manual.pdf'],
    ['video/mp4', 'clip.mp4'],
    ['application/octet-stream', 'data.bin'],
    ['text/csv', undefined],
  ])('admits %s (%s)', (type, name) => {
    expect(isDeniedUploadType(type, name)).toBe(false);
  });
});

describe('serving', () => {
  it('is inline only for media a browser renders without running anything', () => {
    for (const type of ['image/png', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain']) {
      expect({ type, inline: isInlineServableType(type) }).toEqual({ type, inline: true });
    }
    for (const type of ['image/svg+xml', 'text/html', 'application/zip', 'application/json']) {
      expect({ type, disposition: contentDispositionFor(type) }).toEqual({
        type,
        disposition: 'attachment',
      });
    }
  });
});

describe('largeUploadPartSize', () => {
  it('is at least 8 MiB, whole MiB, and fits 8 GiB in 10,000 parts', () => {
    expect(largeUploadPartSize(1)).toBe(8 * 1024 ** 2);
    const size = largeUploadPartSize(LARGE_UPLOAD_MAX_BYTES);
    expect(size % 1024 ** 2).toBe(0);
    expect(Math.ceil(LARGE_UPLOAD_MAX_BYTES / size)).toBeLessThanOrEqual(LARGE_UPLOAD_MAX_PARTS);
    expect(
      Math.ceil(
        (LARGE_UPLOAD_MAX_PARTS * 9 * 1024 ** 2) /
          largeUploadPartSize(LARGE_UPLOAD_MAX_PARTS * 9 * 1024 ** 2),
      ),
    ).toBeLessThanOrEqual(LARGE_UPLOAD_MAX_PARTS);
  });
});

describe('extensions', () => {
  it('prefers the type, then the name, else none', () => {
    expect(storedExtensionFor('application/pdf', 'x.bin')).toBe('.pdf');
    expect(storedExtensionFor('application/x-custom', 'model.STEP')).toBe('.step');
    expect(storedExtensionFor('application/x-custom')).toBe('');
    expect(fileNameExtension('.hidden')).toBeNull();
    expect(fileNameExtension('dir/archive.tar.gz')).toBe('gz');
  });
});
