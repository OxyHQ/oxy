import type { NextFunction, Request, Response } from 'express';
import {
  buildOxyCspDirectives,
  buildOxyPagesHeaders,
  createOxySecurityHeaders,
  cspSourcesFor,
  extractInlineScripts,
  formatOxyCspPolicy,
  inlineScriptCspHash,
  OXY_CSP_BASELINE,
  type OxyCspExtensions,
} from '../securityHeaders';

const CLOUDFLARE_SCRIPT_HOST = 'https://static.cloudflareinsights.com';
const CLOUDFLARE_REPORT_HOST = 'https://cloudflareinsights.com';

/** Run the middleware and return the CSP header exactly as a browser would see it. */
function renderPolicy(options: Parameters<typeof createOxySecurityHeaders>[0]): string {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string | number | readonly string[]): void => {
      headers[name] = String(value);
    },
    removeHeader: (): void => undefined,
  } as unknown as Response;
  const req = { method: 'GET', headers: {} } as unknown as Request;
  const next = jest.fn() as unknown as NextFunction;

  createOxySecurityHeaders(options)(req, res, next);
  return headers['Content-Security-Policy'] ?? '';
}

/** The CSP value parsed back out of a Cloudflare Pages `_headers` block. */
function cspOf(block: string): string {
  const line = block.split('\n').find((entry) => entry.trim().startsWith('Content-Security-Policy:'));
  if (line === undefined) throw new Error('no Content-Security-Policy line in _headers block');
  return line.trim().slice('Content-Security-Policy:'.length).trim();
}

describe('@oxyhq/core/server buildOxyCspDirectives', () => {
  it('carries the Cloudflare Insights beacon on BOTH halves of the baseline', () => {
    // The bug this helper exists for: the script host alone leaves the beacon
    // loading but unable to report, which looks fixed and is not.
    const directives = buildOxyCspDirectives();
    expect(directives['script-src']).toContain(CLOUDFLARE_SCRIPT_HOST);
    expect(directives['connect-src']).toContain(CLOUDFLARE_REPORT_HOST);
  });

  it('carries the Oxy platform origins every app reaches through the SDK', () => {
    const directives = buildOxyCspDirectives();
    expect(directives['connect-src']).toEqual(
      expect.arrayContaining(['https://api.oxy.so', 'wss://api.oxy.so', 'https://cloud.oxy.so']),
    );
    expect(directives['img-src']).toContain('https://cloud.oxy.so');
    expect(directives['media-src']).toContain('https://cloud.oxy.so');
  });

  it('emits the hardening floor: closed object-src/script-src-attr and upgrade-insecure-requests', () => {
    const directives = buildOxyCspDirectives();
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['script-src-attr']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['upgrade-insecure-requests']).toEqual([]);
  });

  it('MERGES an extension into the baseline instead of replacing it', () => {
    const directives = buildOxyCspDirectives({
      scriptSrc: ['https://app.example.com'],
      connectSrc: ['wss://api.example.com'],
    });

    // The extension is present…
    expect(directives['script-src']).toContain('https://app.example.com');
    expect(directives['connect-src']).toContain('wss://api.example.com');
    // …and every baseline source SURVIVED it.
    for (const source of OXY_CSP_BASELINE.scriptSrc ?? []) {
      expect(directives['script-src']).toContain(source);
    }
    for (const source of OXY_CSP_BASELINE.connectSrc ?? []) {
      expect(directives['connect-src']).toContain(source);
    }
  });

  it("retains 'self' in every extended directive, including directives absent from the baseline", () => {
    // The footgun: an explicit `script-src` replaces helmet's default and drops
    // `'self'`, so the app's own bundle stops loading.
    const extensions: OxyCspExtensions = {
      scriptSrc: ['https://app.example.com'],
      connectSrc: ['https://api.example.com'],
      imgSrc: ['blob:'],
      mediaSrc: ['blob:'],
      styleSrc: ['https://fonts.example.com'],
      fontSrc: ['https://fonts.example.com'],
      // Not in the baseline at all — must still be seeded with 'self'.
      frameSrc: ['https://player.vimeo.com'],
      workerSrc: ['blob:'],
      manifestSrc: ['https://cdn.example.com'],
      scriptSrcElem: ['https://app.example.com'],
      styleSrcElem: ['https://cdn.example.com'],
    };
    const directives = buildOxyCspDirectives(extensions);

    for (const directive of Object.keys(extensions)) {
      const headerName = directive.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      expect(directives[headerName]).toContain("'self'");
    }
  });

  it('dedupes sources a caller repeats or that already exist in the baseline', () => {
    const directives = buildOxyCspDirectives({
      scriptSrc: ["'self'", CLOUDFLARE_SCRIPT_HOST, 'https://app.example.com'],
      frameSrc: ["'self'", 'https://player.vimeo.com', 'https://player.vimeo.com'],
    });

    expect(directives['script-src']).toEqual([
      "'self'",
      CLOUDFLARE_SCRIPT_HOST,
      'https://app.example.com',
    ]);
    expect(directives['frame-src']).toEqual(["'self'", 'https://player.vimeo.com']);
  });

  it("drops the 'none' sentinel when a closed directive is opened, and keeps it otherwise", () => {
    // 'none' alongside any other source is meaningless per the CSP spec, so an
    // app that must be framable opts back in explicitly.
    expect(buildOxyCspDirectives({ frameAncestors: ["'self'"] })['frame-ancestors']).toEqual([
      "'self'",
    ]);
    expect(buildOxyCspDirectives({ objectSrc: [] })['object-src']).toEqual(["'none'"]);
  });

  it('rejects sources that would terminate the directive or the policy', () => {
    expect(() => buildOxyCspDirectives({ scriptSrc: ["https://a.example.com; script-src 'unsafe-inline'"] })).toThrow(
      /script-src/,
    );
    expect(() => buildOxyCspDirectives({ connectSrc: ['https://a.example.com,https://b.example.com'] })).toThrow(
      /connect-src/,
    );
    expect(() => buildOxyCspDirectives({ imgSrc: [''] })).toThrow(/img-src/);
  });

  it('never mutates the exported baseline across calls', () => {
    const before = [...(OXY_CSP_BASELINE.scriptSrc ?? [])];
    buildOxyCspDirectives({ scriptSrc: ['https://app.example.com'] });
    buildOxyCspDirectives({ scriptSrc: ['https://other.example.com'] });
    expect([...(OXY_CSP_BASELINE.scriptSrc ?? [])]).toEqual(before);
    expect(buildOxyCspDirectives()['script-src']).toEqual(before);
  });
});

describe('@oxyhq/core/server formatOxyCspPolicy', () => {
  it('serializes directives into a single CSP header value', () => {
    const policy = formatOxyCspPolicy(buildOxyCspDirectives());
    expect(policy).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy.endsWith('upgrade-insecure-requests')).toBe(true);
  });
});

describe('@oxyhq/core/server buildOxyPagesHeaders', () => {
  it('emits a Cloudflare Pages _headers block with CSP and hardening headers', () => {
    const block = buildOxyPagesHeaders();
    expect(block.startsWith('/*\n')).toBe(true);
    expect(block).toContain('Content-Security-Policy:');
    expect(block).toContain(CLOUDFLARE_SCRIPT_HOST);
    expect(block).toContain(CLOUDFLARE_REPORT_HOST);
    expect(block).toContain('X-Frame-Options: DENY');
    expect(block).toContain('Strict-Transport-Security:');
  });

  it('merges per-app CSP extensions into the deployed header', () => {
    const block = buildOxyPagesHeaders({
      csp: { workerSrc: ["'self'"], imgSrc: ['blob:', 'https:'] },
    });
    expect(block).toContain("worker-src 'self'");
    expect(block).toContain('blob:');
    expect(block).toContain('https:');
    expect(block).toContain(CLOUDFLARE_SCRIPT_HOST);
  });
});

/**
 * The inline script Expo Router's static export emits, verbatim, and the hash
 * `accounts.oxy.so` was measured rejecting on 2026-08-21. Pinned as a LITERAL
 * rather than recomputed: a test that derives the expected value the same way
 * the code does would pass against any hashing bug they share.
 */
const EXPO_HYDRATE_SCRIPT = 'globalThis.__EXPO_ROUTER_HYDRATE__=true;';
const EXPO_HYDRATE_SHA256 = "'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='";

/** A static Expo export's HTML, reduced to the parts that decide the policy. */
function expoExportHtml(body = EXPO_HYDRATE_SCRIPT): string {
  return [
    '<!DOCTYPE html><html><head>',
    '<script src="/_expo/static/js/web/entry-abc.js" defer></script>',
    `<script type="module">${body}</script>`,
    '</head><body><div id="root"></div></body></html>',
  ].join('');
}

describe('@oxyhq/core/server extractInlineScripts', () => {
  it('returns inline bodies and skips external scripts', () => {
    expect(extractInlineScripts(expoExportHtml())).toEqual([EXPO_HYDRATE_SCRIPT]);
  });

  it('does not let a ">" inside an attribute value truncate an inline tag', () => {
    // Truncating here does not throw: the body window shifts right and the hash
    // is taken over `b'>globalThis…`, which allows nothing. Note the attribute
    // must precede the body for this to discriminate — an EXTERNAL script whose
    // `src` comes first is skipped either way, which is why the beacon shape is
    // not the case under test here.
    const html = `<script type="module" data-x='a>b'>${EXPO_HYDRATE_SCRIPT}</script>`;
    expect(extractInlineScripts(html)).toEqual([EXPO_HYDRATE_SCRIPT]);
  });

  it('still recognizes a src that follows a ">"-bearing attribute', () => {
    // The mirror failure: truncation hides `src` from the attribute slice, so
    // an external script is mistaken for an inline one and contributes a hash
    // over a fragment of its own tag.
    expect(extractInlineScripts(`<script data-x='a>b' src="/entry.js"></script>`)).toEqual([]);
  });

  it('hashes the exact bytes, so whitespace changes the source', () => {
    expect(inlineScriptCspHash(EXPO_HYDRATE_SCRIPT)).toBe(EXPO_HYDRATE_SHA256);
    expect(inlineScriptCspHash(` ${EXPO_HYDRATE_SCRIPT}`)).not.toBe(EXPO_HYDRATE_SHA256);
  });
});

describe('@oxyhq/core/server buildOxyPagesHeaders inline-script hashes', () => {
  it('allows the built HTML\'s inline script by hash', () => {
    const block = buildOxyPagesHeaders({ html: [expoExportHtml()] });
    expect(cspSourcesFor(cspOf(block), 'script-src')).toEqual([
      "'self'",
      CLOUDFLARE_SCRIPT_HOST,
      EXPO_HYDRATE_SHA256,
    ]);
  });

  it('emits no hash at all when the build has no inline script', () => {
    // Negative control for the assertion above: without it, "contains a
    // sha256-" would be satisfied by a builder that hashed unconditionally.
    const block = buildOxyPagesHeaders({ html: ['<html><body>nothing inline</body></html>'] });
    expect(cspOf(block)).not.toContain('sha256-');
    expect(cspSourcesFor(cspOf(block), 'script-src')).toEqual(["'self'", CLOUDFLARE_SCRIPT_HOST]);
  });

  it('dedupes one route-per-file export down to a single hash', () => {
    const block = buildOxyPagesHeaders({
      html: [expoExportHtml(), expoExportHtml(), expoExportHtml()],
    });
    expect(cspOf(block).match(/sha256-/g)).toHaveLength(1);
  });

  it('keeps per-app extensions and the baseline alongside the hash', () => {
    const block = buildOxyPagesHeaders({
      csp: { imgSrc: ['blob:'], connectSrc: ['blob:'] },
      html: [expoExportHtml()],
    });
    expect(cspSourcesFor(cspOf(block), 'img-src')).toContain('blob:');
    expect(cspSourcesFor(cspOf(block), 'script-src')).toContain(EXPO_HYDRATE_SHA256);
    expect(cspSourcesFor(cspOf(block), 'script-src')).toContain("'self'");
  });

  it('never hashes styles, which would disable style-src unsafe-inline', () => {
    // A style hash would neutralize 'unsafe-inline' and render every
    // react-native-web app unstyled — the one directive that must stay open.
    const block = buildOxyPagesHeaders({
      html: ['<html><head><style>.a{color:red}</style></head></html>'],
    });
    expect(cspSourcesFor(cspOf(block), 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(cspOf(block)).not.toContain('sha256-');
  });

  it('refuses a build whose inline scripts vary per route', () => {
    // An Expo route loader emits `__EXPO_ROUTER_LOADER_DATA__` with different
    // bytes per route. The hashes would still be correct; the policy would grow
    // with the route count. That has to be a decision, so it fails loudly.
    const perRoute = Array.from({ length: 9 }, (_, index) =>
      expoExportHtml(`globalThis.__EXPO_ROUTER_LOADER_DATA__={"r":${index}};`),
    );
    expect(() => buildOxyPagesHeaders({ html: perRoute })).toThrow(RangeError);
    expect(() => buildOxyPagesHeaders({ html: perRoute.slice(0, 8) })).not.toThrow();
  });
});

describe('@oxyhq/core/server createOxySecurityHeaders', () => {
  it('sends the resolved baseline as a real Content-Security-Policy header', () => {
    const policy = renderPolicy({});

    expect(cspSourcesFor(policy, 'script-src')).toEqual(["'self'", CLOUDFLARE_SCRIPT_HOST]);
    expect(cspSourcesFor(policy, 'connect-src')).toEqual([
      "'self'",
      CLOUDFLARE_REPORT_HOST,
      'https://api.oxy.so',
      'wss://api.oxy.so',
      'https://cloud.oxy.so',
    ]);
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('sends merged app extensions without losing the baseline', () => {
    const policy = renderPolicy({
      csp: {
        connectSrc: ['https://api.mention.earth', 'wss://api.mention.earth'],
        frameSrc: ['https://www.youtube-nocookie.com'],
      },
    });

    expect(cspSourcesFor(policy, 'connect-src')).toEqual([
      "'self'",
      CLOUDFLARE_REPORT_HOST,
      'https://api.oxy.so',
      'wss://api.oxy.so',
      'https://cloud.oxy.so',
      'https://api.mention.earth',
      'wss://api.mention.earth',
    ]);
    expect(cspSourcesFor(policy, 'frame-src')).toEqual([
      "'self'",
      'https://www.youtube-nocookie.com',
    ]);
  });

  it('passes non-CSP helmet options through and calls next()', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string | number | readonly string[]): void => {
        headers[name] = String(value);
      },
      removeHeader: (): void => undefined,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction & jest.Mock;

    createOxySecurityHeaders({
      helmet: {
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        frameguard: { action: 'deny' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      },
    })({ method: 'GET', headers: {} } as unknown as Request, res, next);

    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Content-Security-Policy']).toContain("script-src 'self'");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
