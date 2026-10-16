/**
 * What an Oxy file may be, and how it is served (ADR 0043 stage 4b).
 *
 * The large upload (`/assets/service/app/uploads`, `/service/user-media/uploads`)
 * stores files of ANY type, and Oxy serves files from two origins of its own:
 * the API (`/assets/:id/stream`) and the CDN (`cloud.oxy.so`, whose origin is
 * the bucket). A type a browser EXECUTES when it renders a response — HTML,
 * XML, script — would run as those origins, so:
 *
 *  - {@link isDeniedUploadType} refuses executables, installers and active
 *    documents at upload (415 `UNSUPPORTED_MEDIA_TYPE`), by type AND by the
 *    file name's extension, so `application/octet-stream` named `setup.exe`
 *    is refused too;
 *  - {@link contentDispositionFor} answers `inline` only for media a browser
 *    renders without running anything ({@link isInlineServableType}) and
 *    `attachment` for everything else. The large upload stores it ON the
 *    object, so the CDN replays it; the API's stream route sends it (with a
 *    `sandbox` CSP) for every file, whichever path stored it.
 *
 * SVG (stage 4c) is the one active document Oxy stores: only as the output of
 * `utils/svgSanitizer.ts` (every upload and import path sanitizes it), served
 * inline — `<img>` never runs an SVG's script — with
 * {@link SVG_CONTENT_SECURITY_POLICY}, which neuters a direct navigation.
 * `.svgz` (compressed) stays refused.
 */

/** The largest file the multipart upload accepts. */
export const LARGE_UPLOAD_MAX_BYTES = 8 * 1024 ** 3;

/** Smallest part (S3's minimum is 5 MiB for every part but the last). */
export const LARGE_UPLOAD_MIN_PART_BYTES = 8 * 1024 ** 2;

/** S3's ceiling on parts per multipart upload. */
export const LARGE_UPLOAD_MAX_PARTS = 10_000;

/**
 * The part size for a file of `size` bytes: at least 8 MiB, in whole MiB, and
 * large enough that the file fits in S3's 10,000 parts.
 */
export function largeUploadPartSize(size: number): number {
  const mib = 1024 ** 2;
  const needed = Math.ceil(size / LARGE_UPLOAD_MAX_PARTS);
  return Math.max(LARGE_UPLOAD_MIN_PART_BYTES, Math.ceil(needed / mib) * mib);
}

/** RFC 6838 type/subtype token characters. */
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * A declared content type, lowercased and without parameters (`text/plain;
 * charset=utf-8` → `text/plain`), or `null` when it is not a well-formed type.
 */
export function normalizeContentType(raw: string): string | null {
  const type = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_PATTERN.test(type) ? type : null;
}

/**
 * Types refused outright. Active documents a browser runs (HTML, XHTML, SVG,
 * XML with its stylesheets, script), and programs and installers: Oxy Files is
 * not a place to distribute executables from Oxy's own domains.
 */
const DENIED_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/xslt+xml',
  'text/xsl',
  'application/mathml+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'text/vbscript',
  'application/hta',
  'application/x-httpd-php',
  'application/x-php',
  'application/x-sh',
  'application/x-csh',
  'text/x-shellscript',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/x-ms-dos-executable',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sharedlib',
  'application/x-msi',
  'application/x-ms-installer',
  'application/x-ms-shortcut',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/x-debian-package',
  'application/vnd.debian.binary-package',
  'application/x-rpm',
  'application/x-redhat-package-manager',
  'application/java-archive',
  'application/x-java-archive',
  'application/x-java-jnlp-file',
  'application/wasm',
]);

/**
 * Families refused by prefix: every HTML-like subtype. Every SVG spelling but
 * `image/svg+xml` itself (which is sanitized, never stored as sent) is refused
 * by {@link isOtherSvgSpelling}.
 */
const DENIED_TYPE_PREFIXES = ['text/html', 'application/x-msdos', 'application/x-ms-'];

/** An SVG spelling other than the one Oxy sanitizes (`image/svg`, `image/svg-xml`…). */
function isOtherSvgSpelling(type: string): boolean {
  return type.startsWith('image/svg') && type !== 'image/svg+xml';
}

/** Extensions refused whatever type is declared (lowercase, without the dot). */
const DENIED_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'xht',
  'shtml',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'hta',
  'php',
  'exe',
  'dll',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msix',
  'msp',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'sh',
  'bash',
  'csh',
  'ksh',
  'zsh',
  'command',
  'app',
  'dmg',
  'pkg',
  'apk',
  'aab',
  'ipa',
  'deb',
  'rpm',
  'appimage',
  'jar',
  'jnlp',
  'lnk',
  'reg',
  'elf',
  'so',
  'dylib',
  'wasm',
]);

/** The file name's extension, lowercase and without the dot, or `null`. */
export function fileNameExtension(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : null;
}

/** Whether an upload of `type` (normalized) named `name` is refused. */
export function isDeniedUploadType(type: string, name?: string | null): boolean {
  if (DENIED_TYPES.has(type)) return true;
  if (DENIED_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
  if (isOtherSvgSpelling(type)) return true;
  const ext = fileNameExtension(name);
  // A `.svg` name is an SVG only when it is declared as one, and so sanitized.
  if (ext === 'svg') return type !== 'image/svg+xml';
  return ext !== null && DENIED_EXTENSIONS.has(ext);
}

/**
 * Types a browser renders in place without running anything: raster images,
 * audio, video, PDF (rendered by the browser's sandboxed viewer) and plain
 * text (sent with `nosniff`) — and SANITIZED SVG (`image/svg+xml`), with
 * {@link SVG_CONTENT_SECURITY_POLICY}. The stream route serves a stored SVG
 * inline only when the server recorded its sanitization
 * (`svgSanitizer.isSanitizedSvgFile`); any other SVG is a download.
 */
export function isInlineServableType(type: string): boolean {
  const normalized = normalizeContentType(type) ?? '';
  if (normalized === 'image/svg+xml') return true;
  if (normalized.startsWith('image/svg')) return false;
  return (
    normalized.startsWith('image/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('audio/') ||
    normalized === 'application/pdf' ||
    normalized === 'text/plain'
  );
}

/** `inline` for {@link isInlineServableType}, `attachment` for everything else. */
export function contentDispositionFor(type: string): 'inline' | 'attachment' {
  return isInlineServableType(type) ? 'inline' : 'attachment';
}

/**
 * The CSP a sanitized SVG is served with, by the API and (the CloudFront
 * Function in the ADR's runbook) by the CDN: nothing loads, inline styles
 * apply, and a direct navigation gets a sandboxed, scriptless document.
 */
export const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The CSP a download (any type that is not inline-safe) is served with. */
export const ATTACHMENT_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'";

/**
 * The `Content-Security-Policy` a response of `type` carries: the SVG policy
 * for SVG, the attachment policy for every type that is not inline-safe, none
 * for inline media.
 */
export function contentSecurityPolicyFor(type: string): string | null {
  const normalized = normalizeContentType(type) ?? '';
  if (normalized === 'image/svg+xml') return SVG_CONTENT_SECURITY_POLICY;
  return isInlineServableType(normalized) ? null : ATTACHMENT_CONTENT_SECURITY_POLICY;
}

const TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'model/gltf-binary': 'glb',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

/**
 * The stored extension (with its dot, as `files.ext`), from the type when it is
 * a known one, else the file name's, else none. A denied extension never
 * reaches here: the upload was refused first.
 */
export function storedExtensionFor(type: string, name?: string | null): string {
  const known = TYPE_EXTENSIONS[type];
  if (known) return `.${known}`;
  const ext = fileNameExtension(name);
  return ext ? `.${ext}` : '';
}
