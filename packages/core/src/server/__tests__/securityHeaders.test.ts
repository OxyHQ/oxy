import type { NextFunction, Request, Response } from 'express';
import {
  buildOxyCspDirectives,
  createOxySecurityHeaders,
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

/** The sources of one directive, parsed back out of the rendered header. */
function policySources(policy: string, directive: string): string[] {
  const found = policy
    .split(';')
    .map((segment) => segment.trim())
    .find((segment) => segment === directive || segment.startsWith(`${directive} `));
  if (found === undefined) return [];
  return found.split(/\s+/).slice(1);
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

describe('@oxyhq/core/server createOxySecurityHeaders', () => {
  it('sends the resolved baseline as a real Content-Security-Policy header', () => {
    const policy = renderPolicy({});

    expect(policySources(policy, 'script-src')).toEqual(["'self'", CLOUDFLARE_SCRIPT_HOST]);
    expect(policySources(policy, 'connect-src')).toEqual([
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

    expect(policySources(policy, 'connect-src')).toEqual([
      "'self'",
      CLOUDFLARE_REPORT_HOST,
      'https://api.oxy.so',
      'wss://api.oxy.so',
      'https://cloud.oxy.so',
      'https://api.mention.earth',
      'wss://api.mention.earth',
    ]);
    expect(policySources(policy, 'frame-src')).toEqual([
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
