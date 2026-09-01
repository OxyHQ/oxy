/**
 * HTML Transform Utilities for Email Content
 *
 * Transforms email HTML to route external resources through our proxy,
 * providing CORS bypass and tracking protection.
 */

const DANGEROUS_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
];
const DANGEROUS_URL_SCHEMES = /^(?:javascript|data|vbscript|file):/i;

function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function isSafeEmailUrl(value: string): boolean {
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/')) return true;
  if (DANGEROUS_URL_SCHEMES.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:', 'mailto:', 'tel:', 'cid:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Remove active content and dangerous URLs from untrusted email HTML before it is
 * rendered in an iframe or native WebView. This is intentionally conservative:
 * email markup should be display-only, with no scripts, forms, event handlers,
 * or javascript/data/file navigations.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';

  let sanitized = html;

  for (const tag of DANGEROUS_TAGS) {
    sanitized = sanitized.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    sanitized = sanitized.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  sanitized = sanitized.replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  sanitized = sanitized.replace(
    /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_match, attr: string, _raw: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      return isSafeEmailUrl(value) ? ` ${attr}="${escapeAttributeValue(value)}"` : '';
    },
  );

  sanitized = sanitized.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (match, _quote, url: string) => (isSafeEmailUrl(url) ? match : 'url(about:blank)'),
  );

  // Drop remote webfonts. Each one is a request to the sender's server the
  // moment the mail is opened — the same read receipt a tracking pixel gives
  // them, dressed as typography. The message renders in the reader's own font
  // instead. (`@font-face` never nests, so a flat block match is exact.)
  sanitized = sanitized.replace(/@font-face\s*\{[^}]*\}/gi, '');

  return sanitized;
}

const INTERNAL_DOMAINS = ['oxy.so', 'localhost', '127.0.0.1'];

function isExternalUrl(url: string): boolean {
  if (!url || url.startsWith('data:') || url.startsWith('#') || url.startsWith('/')) {
    return false;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const { hostname } = new URL(url);
      return !INTERNAL_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }

  return false;
}

function buildProxyUrl(originalUrl: string, proxyBaseUrl: string): string {
  // btoa() only handles Latin1 — encode as UTF-8 first to avoid DOMException
  // on internationalized URLs. The backend decodes with Buffer.from(x, 'base64').toString('utf-8').
  const bytes = new TextEncoder().encode(originalUrl);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const encoded = btoa(binary);
  return `${proxyBaseUrl}?url=${encodeURIComponent(encoded)}`;
}

/**
 * Transform email HTML to route external images and fonts through our proxy.
 */
export function proxyExternalImages(html: string, proxyBaseUrl: string): string {
  if (!html || !proxyBaseUrl) return html;

  // Transform <img src="...">
  let result = html.replace(
    /(<img[^>]+src\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, src, suffix) =>
      isExternalUrl(src) ? `${prefix}${buildProxyUrl(src, proxyBaseUrl)}${suffix}` : match
  );

  // Transform <source srcset="...">
  result = result.replace(
    /(<source[^>]+srcset\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, srcset, suffix) => {
      const transformed = srcset
        .split(',')
        .map((entry: string) => {
          const [url, ...rest] = entry.trim().split(/\s+/);
          if (isExternalUrl(url)) {
            return rest.length ? `${buildProxyUrl(url, proxyBaseUrl)} ${rest.join(' ')}` : buildProxyUrl(url, proxyBaseUrl);
          }
          return entry;
        })
        .join(', ');
      return `${prefix}${transformed}${suffix}`;
    }
  );

  // Transform url(...) in CSS
  result = result.replace(
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (match, url) => (isExternalUrl(url) ? `url("${buildProxyUrl(url, proxyBaseUrl)}")` : match)
  );

  return result;
}

/**
 * Replace cid: references in email HTML with actual attachment URLs.
 */
export function resolveCidImages(html: string, cidMap: Record<string, string>): string {
  if (!html || Object.keys(cidMap).length === 0) return html;
  return html.replace(
    /(['"])cid:([^'"]+)(['"])/gi,
    (match, q1, cid, q2) => {
      const url = cidMap[cid];
      return url ? `${q1}${url}${q2}` : match;
    },
  );
}

/**
 * Get the proxy base URL based on the current environment
 */
export function getProxyBaseUrl(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';
  return `${apiUrl}/email/proxy`;
}
