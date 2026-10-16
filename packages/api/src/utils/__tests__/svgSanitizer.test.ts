/**
 * Safe SVG (ADR 0043 stage 4c, `utils/svgSanitizer.ts`): what an uploaded SVG
 * may keep, against a corpus of real attack payloads, and that a benign one
 * keeps its drawing — and still rasterizes.
 */

import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import {
  isSanitizedSvgFile,
  sanitizeCss,
  sanitizeSvg,
  SVG_MAX_BYTES,
  withoutServerSvgMetadata,
} from '../svgSanitizer';
import { ApiError } from '../error';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

function svg(body: string, attributes = ''): string {
  return `<svg ${NS} viewBox="0 0 100 100" width="100" height="100"${attributes}>${body}</svg>`;
}

function clean(input: string): string {
  return sanitizeSvg(Buffer.from(input)).bytes.toString('utf8');
}

function refusal(input: string | Buffer): ApiError {
  try {
    sanitizeSvg(Buffer.isBuffer(input) ? input : Buffer.from(input));
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Nothing that runs, navigates or fetches survives. */
function expectInert(output: string): void {
  expect(output).not.toMatch(/<script/i);
  expect(output).not.toMatch(/\son[a-z]+\s*=/i);
  expect(output).not.toMatch(/javascript:/i);
  expect(output).not.toMatch(/foreignObject/i);
  expect(output).not.toMatch(/@import/i);
  expect(output).not.toMatch(/url\(\s*(?!#)/i);
  expect(output).not.toMatch(/href="(?!#)/i);
  expect(output).not.toMatch(/<(iframe|embed|object|set|animate)\b/i);
  expect(output).not.toMatch(/expression\(|-moz-binding|behavior:/i);
}

describe('sanitizeSvg — the attack corpus', () => {
  const corpus: Array<[string, string]> = [
    ['a script element', svg('<script>alert(1)</script><rect width="1" height="1"/>')],
    ['a script with CDATA', svg('<script><![CDATA[alert(1)]]></script>')],
    ['an onload on the root', `<svg ${NS} onload="alert(1)"><rect/></svg>`],
    ['mixed-case handlers', svg('<rect OnClick="alert(1)" oNmOuSeOvEr="alert(2)" width="1"/>')],
    ['a javascript: link', svg('<a href="javascript:alert(1)"><text>x</text></a>')],
    ['a javascript: xlink', svg('<a xlink:href="JaVaScRiPt:alert(1)"><text>x</text></a>')],
    ['an entity-encoded javascript:', svg('<a href="&#106;avascript:alert(1)"><text>x</text></a>')],
    [
      'a data: link',
      svg('<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"><text>x</text></a>'),
    ],
    ['an external use', svg('<use href="https://evil.example/sprite.svg#icon"/>')],
    ['an external xlink use', svg('<use xlink:href="//evil.example/sprite.svg#icon"/>')],
    [
      'an external image',
      svg('<image href="https://evil.example/track.png" width="1" height="1"/>'),
    ],
    [
      'a data: image',
      svg('<image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/>'),
    ],
    [
      'foreignObject with HTML',
      svg(
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/><img src="x" onerror="alert(1)"/></body></foreignObject>',
      ),
    ],
    [
      'an @import',
      svg('<style>@import url(https://evil.example/x.css); rect { fill: red }</style>'),
    ],
    ['a quoted @import', svg('<style>@import "https://evil.example/x.css";</style>')],
    [
      'an external url() in a style',
      svg('<style>rect { fill: url(https://evil.example/p.png) }</style>'),
    ],
    ['a style attribute url', svg('<rect style="background:url(//evil.example/x)" width="1"/>')],
    ['an escaped url (u\\rl)', svg('<style>rect { background: u\\rl(//evil.example/x) }</style>')],
    [
      'a hex-escaped url (\\75 rl)',
      svg('<style>rect { background: \\75 rl(//evil.example/x) }</style>'),
    ],
    ['a comment-split url', svg('<style>rect { background: url/**/(//evil.example/x) }</style>')],
    [
      'image-set()',
      svg(
        '<rect style="background-image:image-set(&quot;https://evil.example/x.png&quot; 1x)" width="1"/>',
      ),
    ],
    ['expression()', svg('<rect style="width:expression(alert(1))" width="1"/>')],
    [
      '-moz-binding',
      svg('<rect style="-moz-binding:url(https://evil.example/x.xml#b)" width="1"/>'),
    ],
    ['a presentation url', svg('<rect fill="url(https://evil.example/x.svg#g)" width="1"/>')],
    [
      'an animate setting href',
      svg(
        '<a href="#x"><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a>',
      ),
    ],
    [
      'a set setting a handler',
      svg('<rect width="1"><set attributeName="onmouseover" to="alert(1)"/></rect>'),
    ],
    [
      'an animateTransform aimed at href',
      svg('<a><animateTransform attributeName="xlink:href" to="javascript:alert(1)"/></a>'),
    ],
    ['an iframe', svg('<iframe src="https://evil.example"/>')],
    ['an embed and object', svg('<embed src="x.swf"/><object data="x.swf"/>')],
    [
      'an xml-stylesheet instruction',
      `<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?>${svg('<rect/>')}`,
    ],
    ['xml:base', svg('<a xml:base="https://evil.example/" href="#x"><text>x</text></a>')],
    [
      'a namespaced script',
      svg('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>'),
    ],
    [
      'an XHTML script inside',
      svg('<h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script>'),
    ],
    [
      'a script in a title (HTML integration point)',
      svg('<title><![CDATA[</title><script>alert(1)</script>]]></title>'),
    ],
    ['a handler on a nested svg', svg(`<svg ${NS} onload="alert(1)"/>`)],
  ];

  it.each(corpus)('neutralizes %s', (_name, payload) => {
    const output = clean(payload);
    expectInert(output);
    // Still an SVG document.
    expect(output.startsWith('<svg')).toBe(true);
    expect(output).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('never expands an entity (billion laughs) and drops the DTD', () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<svg ${NS}><text>plain</text></svg>`;
    const output = clean(laughs);
    expect(output).not.toMatch(/DOCTYPE|ENTITY|lol/);
    expect(output).toContain('<text>plain</text>');
    // A document that USES a declared entity is not well-formed once the DTD
    // is gone: refused, never expanded.
    const using = laughs.replace('<text>plain</text>', '<text>&d;</text>');
    expect(refusal(using).code).toBe('INVALID_SVG');
  });

  it('reads the tree as XML: an HTML raw-text element cannot swallow or smuggle the rest', () => {
    // As HTML, a self-closed <iframe/> inside foreignObject would turn the rest
    // of the document into its text; as the XML it is, only the foreign subtree
    // goes and the drawing after it stays.
    const output = clean(
      svg(
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/><style/></div></foreignObject><rect id="kept" width="5" height="5"/><title>T<b xmlns="http://www.w3.org/1999/xhtml">x</b></title>',
      ),
    );
    expect(output).toContain('<rect id="kept" width="5" height="5"/>');
    expect(output).toContain('<title>T</title>');
    expectInert(output);
  });

  it('drops elements of any other namespace with their subtree', () => {
    const output = clean(
      svg(
        '<g xmlns:i="urn:inkscape" i:label="layer"><i:metadata><i:x>1</i:x></i:metadata><circle r="2"/></g>',
      ),
    );
    expect(output).toContain('<circle r="2"/>');
    expect(output).not.toMatch(/inkscape|metadata|label/);
  });

  it('drops comments and the XML declaration', () => {
    const output = clean(
      `<?xml version="1.0" encoding="UTF-8"?><!-- hi --><svg ${NS}><!-- <script>alert(1)</script> --><rect/></svg>`,
    );
    expect(output).not.toMatch(/<!--|<\?xml|alert/);
  });

  it('refuses a comment or declaration that dropping another one would assemble', () => {
    // One pass drops `<!---->`, leaving `<!--` + `<script>…`: never stripped twice.
    expect(refusal(`<!<!---->-- --><svg ${NS}><rect/></svg>`).code).toBe('INVALID_SVG');
    expect(refusal(`<svg ${NS}><<!---->?x?><rect/></svg>`).code).toBe('INVALID_SVG');
    expect(refusal(`<svg ${NS}><!-- unterminated<rect/></svg>`).code).toBe('INVALID_SVG');
  });

  it('strips a hostile DOCTYPE in linear time', () => {
    const started = Date.now();
    for (const body of [
      '<!doctype[' + ']['.repeat(50_000),
      '<!doctype[]' + '\t[]'.repeat(50_000),
    ]) {
      expect(refusal(`${body}<svg ${NS}/>`).code).toBe('INVALID_SVG');
    }
    expect(
      clean(`<!DOCTYPE svg [${'<!ENTITY a "b">'.repeat(1000)}]><svg ${NS}><rect/></svg>`),
    ).toContain('<rect/>');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses what is not a UTF-8, well-formed SVG document', () => {
    expect(refusal(`<html><body><svg ${NS}/></body></html>`).code).toBe('INVALID_SVG');
    expect(refusal(`<div xmlns="http://www.w3.org/1999/xhtml"><svg ${NS}/></div>`).code).toBe(
      'INVALID_SVG',
    );
    expect(refusal('<svg><rect></svg>').code).toBe('INVALID_SVG');
    expect(refusal('<svg/>').code).toBe('INVALID_SVG'); // no SVG namespace
    expect(refusal('hello').code).toBe('INVALID_SVG');
    expect(refusal(gzipSync(Buffer.from(svg('<rect/>')))).code).toBe('INVALID_SVG');
    expect(refusal(Buffer.from([0xff, 0xfe, 0x3c, 0x00])).code).toBe('INVALID_SVG');
    expect(refusal(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xc3, 0x28])).code).toBe('INVALID_SVG');
    expect(refusal(`<?xml version="1.0" encoding="ISO-8859-1"?><svg ${NS}/>`).code).toBe(
      'INVALID_SVG',
    );
    expect(refusal(Buffer.alloc(0)).code).toBe('INVALID_SVG');
    const big = refusal(Buffer.alloc(SVG_MAX_BYTES + 1, 0x20));
    expect({ status: big.statusCode, code: big.code }).toEqual({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});

describe('sanitizeSvg — a benign SVG keeps its drawing', () => {
  const logo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg ${NS} viewBox="0 0 120 60" width="120" height="60" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#ff3366"/><stop offset="1" stop-color="#3366ff"/>
    </linearGradient>
    <clipPath id="c"><circle cx="30" cy="30" r="25"/></clipPath>
    <filter id="f"><feGaussianBlur stdDeviation="1.5"/></filter>
    <symbol id="dot" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></symbol>
  </defs>
  <style>.label { font: bold 12px sans-serif; fill: url(#g) }</style>
  <rect width="120" height="60" rx="8" fill="url(#g)" filter="url(#f)"/>
  <g clip-path="url('#c')"><path d="M5 5 L55 55 Z" stroke="#000" stroke-width="2"/></g>
  <use href="#dot" x="100" y="40" width="10" height="10"/>
  <use xlink:href="#dot" x="80" y="40" width="10" height="10"/>
  <text x="60" y="35" class="label">Oxy &amp; co</text>
</svg>`;

  it('keeps geometry, gradients, clip paths, filters, symbols, fragments and text', () => {
    const output = clean(logo);
    for (const kept of [
      'viewBox="0 0 120 60"',
      'preserveAspectRatio="xMidYMid meet"',
      '<linearGradient id="g"',
      'gradientUnits="objectBoundingBox"',
      '<clipPath id="c">',
      '<feGaussianBlur stdDeviation="1.5"',
      'fill="url(#g)"',
      'filter="url(#f)"',
      'clip-path="url(#c)"',
      'href="#dot"',
      'xlink:href="#dot"',
      'd="M5 5 L55 55 Z"',
      'Oxy &amp; co',
      'fill: url(#g)',
    ]) {
      expect({ kept, present: output.includes(kept) }).toEqual({ kept, present: true });
    }
    expectInert(output);
  });

  it('is deterministic and idempotent, and records the original hash', () => {
    const input = Buffer.from(logo);
    const first = sanitizeSvg(input);
    const again = sanitizeSvg(input);
    const twice = sanitizeSvg(first.bytes);
    expect(again.bytes.equals(first.bytes)).toBe(true);
    expect(twice.bytes.equals(first.bytes)).toBe(true);
    expect(twice.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(crypto.createHash('sha256').update(first.bytes).digest('hex'));
    expect(first.record.originalSha256).toBe(
      crypto.createHash('sha256').update(input).digest('hex'),
    );
    expect(first.record.sanitizer).toMatch(/^dompurify@\d+\.\d+\.\d+$/);
  });

  it('every malicious payload sanitizes idempotently too', () => {
    const output = sanitizeSvg(
      Buffer.from(svg('<script>alert(1)</script><a href="javascript:x"><rect onclick="y"/></a>')),
    );
    expect(sanitizeSvg(output.bytes).bytes.equals(output.bytes)).toBe(true);
    expect(output.record.removed.elements + output.record.removed.attributes).toBeGreaterThan(0);
  });

  it('rasterizes the sanitized document to a non-empty webp', async () => {
    const output = sanitizeSvg(Buffer.from(logo)).bytes;
    const webp = await sharp(output, { density: 144 }).resize({ width: 240 }).webp().toBuffer();
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(240);
    const stats = await sharp(webp).stats();
    // Not a blank canvas: the gradient drew.
    expect(stats.channels.some((channel) => channel.max - channel.min > 50)).toBe(true);
  });
});

describe('sanitizeCss', () => {
  it.each([
    ['url(#a)', 'url(#a)', false],
    ["url('#a')", 'url(#a)', true],
    ['url(  "#a"  )', 'url(#a)', true],
    ['fill: URL(https://x)', 'fill: none', true],
    ['@IMPORT "x.css"; a{}', ' a{}', true],
    ['a{b:src("x")}', 'a{b:none}', true],
    ['a{b:cross-fade(url(x), url(y))}', 'a{b:none}', true],
  ])('%s → %s', (input, expected, changed) => {
    expect(sanitizeCss(input)).toEqual({ css: expected, changed });
  });

  it('keeps text that merely mentions a word like url', () => {
    expect(sanitizeCss('font-family: urlfont').changed).toBe(false);
  });
});

describe('the server owns metadata.svg', () => {
  it('drops a caller-supplied svg record', () => {
    expect(withoutServerSvgMetadata({ svg: { sanitizer: 'dompurify@9' }, a: 1 })).toEqual({ a: 1 });
    expect(withoutServerSvgMetadata(undefined)).toBeUndefined();
  });

  it('serves inline only an SVG this module produced', () => {
    const record = sanitizeSvg(Buffer.from(svg('<rect/>'))).record;
    expect(isSanitizedSvgFile({ mime: 'image/svg+xml', metadata: { svg: record } })).toBe(true);
    expect(isSanitizedSvgFile({ mime: 'image/svg+xml', metadata: {} })).toBe(false);
    expect(isSanitizedSvgFile({ mime: 'image/svg+xml', metadata: null })).toBe(false);
    expect(isSanitizedSvgFile({ mime: 'image/png', metadata: { svg: record } })).toBe(false);
  });
});
