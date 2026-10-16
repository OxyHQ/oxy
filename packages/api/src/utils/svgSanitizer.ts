/**
 * Safe SVG (ADR 0043 stage 4c): every SVG Oxy Files stores is the output of
 * this module, never the uploader's bytes.
 *
 * An SVG is an active document: rendered as a page it can run script, load
 * remote resources and navigate. Oxy serves files from its own origins (the
 * API's `/assets/:id/stream` and the CDN), so a raw SVG would run AS those
 * origins. The upload and import paths therefore accept `image/svg+xml` only
 * through {@link sanitizeSvg}: the stored bytes are the sanitized document, the
 * content hash (dedupe, the takedown blocklist) is the hash of THOSE bytes, and
 * the uploader's hash is kept as `metadata.svg.originalSha256`. Serving adds a
 * second, independent layer (`fileContentPolicy.contentSecurityPolicyFor`):
 * `default-src 'none'; style-src 'unsafe-inline'; sandbox`.
 *
 * ## How
 *
 * 1. Bounded, UTF-8 only, never gzip (`.svgz`).
 * 2. The prolog goes: the XML declaration (which may name another encoding),
 *    every DOCTYPE — with its internal subset, so no entity is ever declared,
 *    let alone expanded (billion laughs) — every processing instruction
 *    (`xml-stylesheet`) and comment.
 * 3. The document must be well-formed XML whose root is `<svg>` in the SVG
 *    namespace (jsdom's XML parser), or it is 415 `INVALID_SVG` — a browser
 *    would not render it as an image either.
 * 4. DOMPurify, with its SVG and SVG-filter profiles, is the allow-list
 *    authority over elements and attributes: no script, no `foreignObject`, no
 *    event handler, no `animate`/`set`. It parses the way it was built for (an
 *    SVG in an HTML document, where it compares names case-insensitively); the
 *    result is a DOM, serialized with `XMLSerializer`, so what is stored is
 *    exactly the tree that was checked.
 * 5. On top of DOMPurify, Oxy's own rules: `href`/`xlink:href` survive only as
 *    a same-document fragment (`#id`); every `url(...)` — in a `<style>`, a
 *    `style` attribute or a presentation attribute — survives only as
 *    `url(#id)` and is otherwise `none`; `@import`, the image functions that
 *    take a URL string (`image-set()`, `image()`, `src()`, `cross-fade()`,
 *    `element()`), `expression(`, `javascript:`, `-moz-binding` and
 *    `behavior:` are removed, after CSS escapes and comments are resolved, so
 *    `u\72l(` is a `url(` too; an animation element may not target `href`,
 *    an event handler or `style`.
 *
 * Deterministic and idempotent: the same input always yields the same bytes,
 * and sanitizing the output again yields it unchanged — so the same upload
 * always has the same stored hash.
 */

import crypto from 'node:crypto';
import createDOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';
import { JSDOM } from 'jsdom';
import { ApiError } from './error';

/** The largest SVG accepted (the input; the output is never larger). */
export const SVG_MAX_BYTES = 5 * 1024 * 1024;

/** The one SVG type Oxy stores and serves. */
export const SVG_MIME = 'image/svg+xml';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Is `mime` (normalized, lowercase, without parameters) the SVG type? */
export function isSvgType(mime: string | null | undefined): boolean {
  return (mime ?? '').split(';')[0]?.trim().toLowerCase() === SVG_MIME;
}

/** What the server records about a stored SVG (`files.metadata.svg`). */
export interface SvgSanitizationRecord {
  /** SHA-256 of the bytes the uploader sent. */
  originalSha256: string;
  /** The sanitizer and its version. */
  sanitizer: string;
  /** How many elements and attributes were removed or rewritten. */
  removed: { elements: number; attributes: number };
}

export interface SanitizedSvg {
  bytes: Buffer;
  sha256: string;
  record: SvgSanitizationRecord;
}

function invalidSvg(message: string): ApiError {
  return new ApiError(415, message, 'INVALID_SVG');
}

/** The `metadata.svg` key is the server's: a client-supplied one is dropped. */
export function withoutServerSvgMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata ?? undefined;
  if (!Object.hasOwn(metadata, 'svg')) return metadata;
  const { svg: _dropped, ...rest } = metadata;
  return rest;
}

/**
 * Whether a stored file is an SVG this module produced: the type is SVG and
 * the server recorded its sanitization. Only such a file is served inline; any
 * other SVG (a mail attachment kept byte for byte, a legacy row) is a download.
 */
export function isSanitizedSvgFile(file: {
  mime: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (!isSvgType(file.mime)) return false;
  const record = file.metadata?.svg as Partial<SvgSanitizationRecord> | undefined;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.sanitizer === 'string' &&
    record.sanitizer.startsWith('dompurify@') &&
    typeof record.originalSha256 === 'string'
  );
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Resolve CSS escapes (`\75`, `\72 `, `\(`) and drop comments: what is checked is what is stored. */
function normalizeCss(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  return withoutComments.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_match, hex: string | undefined, newline: string | undefined, other: string | undefined) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        if (
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return '�';
        }
        return String.fromCodePoint(codePoint);
      }
      if (newline) return '';
      return other ?? '';
    },
  );
}

/** A `url(...)` target that stays: a same-document fragment. */
const FRAGMENT_PATTERN = /^#[A-Za-z_][\w.:-]*$/;

/** Index of the `)` closing the parenthesis opened just before `from`, honouring quotes; -1 if none. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** CSS functions that fetch: `url()` is kept as `url(#id)`; the others never stay. */
const FETCHING_FUNCTION =
  /(?<![\w-])(-webkit-image-set|image-set|cross-fade|element|image|src|url)\s*\(/gi;

/** Fragments that never stay in CSS. */
const FORBIDDEN_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:/gi;

export interface CssSanitization {
  css: string;
  changed: boolean;
}

/**
 * Sanitize CSS text (a `<style>` element, a `style` attribute, a presentation
 * attribute's value). Exported for tests.
 */
export function sanitizeCss(raw: string): CssSanitization {
  let css = normalizeCss(raw);
  // `@import` rules, whole (to the `;` or the end).
  css = css.replace(/@import\b[^;]*;?/gi, '');
  // The fetching functions.
  let out = '';
  let cursor = 0;
  FETCHING_FUNCTION.lastIndex = 0;
  for (let match = FETCHING_FUNCTION.exec(css); match; match = FETCHING_FUNCTION.exec(css)) {
    const start = match.index;
    const open = start + match[0].length;
    const close = closingParen(css, open);
    const end = close === -1 ? css.length : close + 1;
    let replacement = 'none';
    if (match[1].toLowerCase() === 'url' && close !== -1) {
      const target = css
        .slice(open, close)
        .trim()
        .replace(/^(['"])([\s\S]*)\1$/, '$2')
        .trim();
      if (FRAGMENT_PATTERN.test(target)) replacement = `url(${target})`;
    }
    out += css.slice(cursor, start) + replacement;
    cursor = end;
    FETCHING_FUNCTION.lastIndex = end;
  }
  out += css.slice(cursor);
  out = out.replace(FORBIDDEN_CSS, '');
  // Anything that still spells a fetch (say, a function split by an unbalanced
  // quote) means the text is not CSS this module understands: none of it stays.
  if (/@import|(?:url|image-set|image|src|cross-fade|element)\s*\((?!#)/i.test(out)) {
    return { css: '', changed: true };
  }
  return { css: out, changed: out !== raw };
}

// ---------------------------------------------------------------------------
// DOMPurify
// ---------------------------------------------------------------------------

const { window } = new JSDOM('');
const purify: DOMPurifyInstance = createDOMPurify(window as unknown as Window & typeof globalThis);
const SANITIZER = `dompurify@${purify.version}`;

/** Removals and rewrites made by Oxy's own rules during one {@link sanitizeSvg} call. */
let ownRemovals = { elements: 0, attributes: 0 };

const LINK_ATTRIBUTES = new Set(['href', 'xlink:href']);
const ANIMATION_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'animatecolor',
]);
const FORBIDDEN_ANIMATION_TARGET = /^(?:xlink:)?href$|^on|^style$/i;

purify.addHook('uponSanitizeElement', (node, data) => {
  const element = node as Element;
  if (data.tagName === 'style' && element.textContent) {
    const { css, changed } = sanitizeCss(element.textContent);
    if (changed) {
      element.textContent = css;
      ownRemovals.elements++;
    }
  }
});

purify.addHook('afterSanitizeAttributes', (node) => {
  const element = node as Element;
  if (!element.attributes) return;
  const name = element.localName?.toLowerCase() ?? '';
  if (ANIMATION_ELEMENTS.has(name)) {
    const target = element.getAttribute('attributeName') ?? element.getAttribute('attributename');
    if (target && FORBIDDEN_ANIMATION_TARGET.test(target.trim())) {
      element.remove();
      ownRemovals.elements++;
      return;
    }
  }
  for (const attribute of [...element.attributes]) {
    const attributeName = attribute.name.toLowerCase();
    const value = attribute.value;
    if (LINK_ATTRIBUTES.has(attributeName) || attribute.localName === 'href') {
      if (!FRAGMENT_PATTERN.test(value.trim())) {
        element.removeAttributeNode(attribute);
        ownRemovals.attributes++;
      } else if (value !== value.trim()) {
        attribute.value = value.trim();
      }
      continue;
    }
    if (/^on/i.test(attribute.localName) || attributeName === 'xml:base') {
      element.removeAttributeNode(attribute);
      ownRemovals.attributes++;
      continue;
    }
    // `style`, and any presentation attribute that can name a URL.
    if (
      attributeName === 'style' ||
      /url|image|src|@import|expression|script|binding|behavior|\\/i.test(value)
    ) {
      const { css, changed } = sanitizeCss(value);
      if (!changed) continue;
      ownRemovals.attributes++;
      if (css.trim().length === 0) element.removeAttributeNode(attribute);
      else attribute.value = css;
    }
  }
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** A markup declaration that never stays (`<!ENTITY …>`, `<!ELEMENT …>`, …). */
const MARKUP_DECLARATION = /^<!(?:ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i;

/**
 * One left-to-right pass of {@link stripProlog}: every DOCTYPE (with its
 * internal subset), stray markup declaration, processing instruction (the XML
 * declaration included) and comment is dropped. A construct with no end is
 * left as it is, and the XML parser refuses the document.
 *
 * A scanner, not regular expressions: it runs in linear time on any input
 * (a DOCTYPE pattern that can match whitespace two ways backtracks
 * exponentially on `<!DOCTYPE[][][]…`).
 */
function stripPrologOnce(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, open);
    let end = -1;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      end = close === -1 ? -1 : close + 3;
    } else if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2);
      end = close === -1 ? -1 : close + 2;
    } else if (text.slice(open, open + 9).toUpperCase() === '<!DOCTYPE') {
      // Up to the first `>` outside the internal subset (`[ … ]`).
      let cursor = open + 9;
      while (cursor < text.length && text[cursor] !== '>') {
        if (text[cursor] === '[') {
          const subsetEnd = text.indexOf(']', cursor + 1);
          if (subsetEnd === -1) break;
          cursor = subsetEnd;
        }
        cursor++;
      }
      end = cursor < text.length && text[cursor] === '>' ? cursor + 1 : -1;
    } else if (MARKUP_DECLARATION.test(text.slice(open, open + 11))) {
      const close = text.indexOf('>', open);
      end = close === -1 ? -1 : close + 1;
    } else {
      out += '<';
      index = open + 1;
      continue;
    }
    if (end === -1) {
      out += text.slice(open);
      break;
    }
    index = end;
  }
  return out;
}

/**
 * Strip the prolog constructs that never stay (see the header, step 2). Dropping
 * one can join its neighbours into another (`<!<!-- -->-- …`); a document that
 * still holds one after the pass is refused rather than stripped again, which
 * keeps this linear and no well-formed SVG ever needs.
 */
function stripProlog(text: string): string {
  const stripped = stripPrologOnce(text);
  if (/<!--|<\?|<!DOCTYPE|<!(?:ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i.test(stripped)) {
    throw invalidSvg('The SVG is not well-formed');
  }
  return stripped;
}

/** Decode UTF-8 strictly (a BOM is dropped); any other encoding is refused. */
function decodeUtf8(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw invalidSvg('Compressed SVG (.svgz) is not accepted; upload the SVG itself');
  }
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))
  ) {
    throw invalidSvg('An SVG must be UTF-8');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw invalidSvg('An SVG must be UTF-8');
  }
  const declaration = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(text);
  if (declaration && !/^(?:utf-?8|us-ascii|ascii)$/i.test(declaration[1].trim())) {
    throw invalidSvg('An SVG must be UTF-8');
  }
  return text;
}

/** Elements whose content an HTML parser reads as HTML (integration points): text only. */
const TEXT_ONLY_ELEMENTS = new Set(['title', 'desc']);

/**
 * Parse `text` as XML — refusing anything but a well-formed document whose
 * root is `<svg>` in the SVG namespace — and reduce it to what an SVG image
 * draws: only SVG-namespace elements (anything else, `foreignObject` and its
 * HTML above all, goes with its subtree — an SVG rendered as an image never
 * shows it), no comment or processing instruction, `<title>`/`<desc>` as text.
 * The result is re-serialized for DOMPurify, so its parse (an SVG inside an
 * HTML document) and the XML one cannot disagree about the tree: nothing is
 * left where they differ (raw-text HTML elements, integration points).
 */
function svgDocumentForSanitizer(text: string): string {
  let dom: JSDOM;
  try {
    dom = new JSDOM(text, { contentType: 'image/svg+xml' });
  } catch {
    throw invalidSvg('The SVG is not well-formed XML');
  }
  const document = dom.window.document;
  const root = document.documentElement;
  if (root?.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    throw invalidSvg('The document is not an SVG (its root must be <svg> in the SVG namespace)');
  }
  const remove: Node[] = [];
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const element = child as Element;
        if (
          element.namespaceURI !== SVG_NAMESPACE ||
          element.localName.toLowerCase() === 'foreignobject' ||
          TEXT_ONLY_ELEMENTS.has((node as Element).localName?.toLowerCase() ?? '')
        ) {
          remove.push(element);
          ownRemovals.elements++;
          continue;
        }
        walk(element);
      } else if (child.nodeType === 7 || child.nodeType === 8) {
        remove.push(child);
      }
    }
  };
  walk(root);
  for (const node of remove) node.parentNode?.removeChild(node);
  const serialized = new dom.window.XMLSerializer().serializeToString(root);
  dom.window.close();
  return serialized;
}

/**
 * Sanitize an uploaded SVG (see the module header). Throws 413
 * `PAYLOAD_TOO_LARGE` above {@link SVG_MAX_BYTES} and 415 `INVALID_SVG` for
 * anything that is not a UTF-8, well-formed SVG document.
 */
export function sanitizeSvg(input: Buffer): SanitizedSvg {
  if (input.length === 0) throw invalidSvg('The SVG is empty');
  if (input.length > SVG_MAX_BYTES) {
    throw new ApiError(413, 'An SVG can be at most 5 MiB', 'PAYLOAD_TOO_LARGE');
  }
  const originalSha256 = crypto.createHash('sha256').update(input).digest('hex');
  ownRemovals = { elements: 0, attributes: 0 };
  const text = svgDocumentForSanitizer(stripProlog(decodeUtf8(input)));

  const fragment = purify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `use` is safe once its reference can only be a fragment (above).
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['foreignObject', 'foreignobject', 'script', 'iframe', 'embed', 'object'],
    ADD_FORBID_CONTENTS: ['foreignobject', 'foreignObject', 'script'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  }) as unknown as HTMLElement;

  const elements = [...fragment.childNodes].filter((node) => node.nodeType === 1) as Element[];
  const root = elements[0];
  if (elements.length !== 1 || root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    throw invalidSvg('Nothing of the SVG survived sanitization');
  }
  // No comment survives anywhere in the tree.
  const walker = root.ownerDocument.createTreeWalker(root, window.NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  for (const comment of comments) comment.parentNode?.removeChild(comment);

  const serialized = new window.XMLSerializer().serializeToString(root);
  const bytes = Buffer.from(serialized, 'utf8');
  let removedElements = ownRemovals.elements;
  let removedAttributes = ownRemovals.attributes;
  for (const entry of purify.removed as Array<{ element?: unknown; attribute?: unknown }>) {
    if (entry.attribute) removedAttributes++;
    else if (entry.element) removedElements++;
  }
  return {
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    record: {
      originalSha256,
      sanitizer: SANITIZER,
      removed: { elements: removedElements, attributes: removedAttributes },
    },
  };
}

/** Read a stream into memory, refusing more than `limit` bytes (413). */
export async function readBounded(
  source: AsyncIterable<Buffer | string | Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new ApiError(413, 'An SVG can be at most 5 MiB', 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
