/**
 * What a large upload may store and how a file is served (ADR 0043 stage 4b,
 * `utils/fileContentPolicy.ts`).
 */

import {
  ATTACHMENT_CONTENT_SECURITY_POLICY,
  contentDispositionFor,
  contentSecurityPolicyFor,
  fileNameExtension,
  isDeniedUploadType,
  isInlineServableType,
  LARGE_UPLOAD_MAX_BYTES,
  SVG_CONTENT_SECURITY_POLICY,
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
    // Every SVG spelling but `image/svg+xml`, which is sanitized (stage 4c).
    ['image/svg'],
    ['image/svg-xml'],
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
    // A `.svg` name is an SVG only when declared as one (then sanitized); a
    // compressed `.svgz` never is.
    expect(isDeniedUploadType('application/octet-stream', 'logo.svg')).toBe(true);
    expect(isDeniedUploadType('image/svg+xml', 'logo.SVGZ')).toBe(true);
  });

  it('admits image/svg+xml, which every path sanitizes', () => {
    expect(isDeniedUploadType('image/svg+xml', 'logo.svg')).toBe(false);
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
    for (const type of ['image/svg', 'text/html', 'application/zip', 'application/json']) {
      expect({ type, disposition: contentDispositionFor(type) }).toEqual({
        type,
        disposition: 'attachment',
      });
    }
  });

  it('serves a (sanitized) SVG inline under a CSP that loads nothing and sandboxes navigation', () => {
    expect(contentDispositionFor('image/svg+xml')).toBe('inline');
    expect(contentSecurityPolicyFor('image/svg+xml; charset=utf-8')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(SVG_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(contentSecurityPolicyFor('application/zip')).toBe(ATTACHMENT_CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor('text/html')).toBe("sandbox; default-src 'none'");
    expect(contentSecurityPolicyFor('image/png')).toBeNull();
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
