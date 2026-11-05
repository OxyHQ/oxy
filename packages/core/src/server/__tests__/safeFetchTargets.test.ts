/**
 * `safeFetch`'s two caller controls over the chain of hops:
 *
 * - `validated`: the first hop reuses the caller's own `assertSafePublicUrl`
 *   check of that exact URL (no second lookup), and nothing else is accepted;
 * - `requireHttps`: no hop of the chain, the first or a redirect, goes out
 *   in the clear.
 *
 * DNS and both transports are faked, so each test sees exactly which hops
 * were resolved, where each connection was pinned and what was refused.
 */
import { EventEmitter } from 'node:events';

const mockDnsLookup = jest.fn();
jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

interface FakeHop {
  status: number;
  location?: string;
}
const mockRoutes = new Map<string, FakeHop>();
const mockSent: Array<{ url: string; pinned: string }> = [];

function mockTransport(protocol: 'http:' | 'https:') {
  return {
    request: (
      options: {
        hostname: string;
        path: string;
        lookup: (h: string, o: object, cb: (e: null, a: string) => void) => void;
      },
      onResponse: (res: unknown) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        end: () => void;
        destroy: () => void;
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      req.end = () => {
        const url = `${protocol}//${options.hostname}${options.path}`;
        let pinned = '';
        options.lookup(options.hostname, {}, (_e, address) => {
          pinned = address;
        });
        mockSent.push({ url, pinned });
        const hop = mockRoutes.get(url) ?? { status: 200 };
        const res = Object.assign(new EventEmitter(), {
          statusCode: hop.status,
          headers: hop.location ? { location: hop.location } : {},
          destroy: jest.fn(),
        });
        queueMicrotask(() => onResponse(res));
      };
      return req;
    },
  };
}
jest.mock('node:http', () => ({ __esModule: true, default: mockTransport('http:') }));
jest.mock('node:https', () => ({ __esModule: true, default: mockTransport('https:') }));

import { assertSafePublicUrl, safeFetch, SsrfRejection, type SsrfCheckOk } from '../safeFetch';

beforeEach(() => {
  mockDnsLookup.mockReset();
  mockRoutes.clear();
  mockSent.length = 0;
});

async function checked(url: string): Promise<SsrfCheckOk> {
  const check = await assertSafePublicUrl(url);
  if (!check.ok) throw new Error(check.reason);
  return check;
}

describe('safeFetch — validated', () => {
  it('connects the first hop to the caller’s check without resolving again', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const check = await checked('https://media.example/a.png');

    const result = await safeFetch('https://media.example/a.png', { validated: check });

    expect(result.status).toBe(200);
    expect(mockDnsLookup).toHaveBeenCalledTimes(1);
    expect(mockSent).toEqual([{ url: 'https://media.example/a.png', pinned: '93.184.216.34' }]);
  });

  it('still resolves and checks every redirect hop', async () => {
    mockDnsLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    mockRoutes.set('https://media.example/a.png', {
      status: 302,
      location: 'https://internal.example/meta',
    });
    const check = await checked('https://media.example/a.png');

    await expect(
      safeFetch('https://media.example/a.png', { validated: check }),
    ).rejects.toBeInstanceOf(SsrfRejection);
    expect(mockDnsLookup).toHaveBeenCalledTimes(2);
    expect(mockSent.map((hop) => hop.url)).toEqual(['https://media.example/a.png']);
  });

  it('refuses a check of another URL before sending anything', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const check = await checked('https://media.example/a.png');

    await expect(
      safeFetch('https://other.example/b.png', { validated: check }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mockSent).toHaveLength(0);
  });

  it('refuses a hand-built check', async () => {
    const forged: SsrfCheckOk = { ok: true, ip: '10.0.0.1', family: 4 };

    await expect(
      safeFetch('https://media.example/a.png', { validated: forged }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mockSent).toHaveLength(0);
  });
});

describe('safeFetch — requireHttps', () => {
  it('refuses a plain-http first hop before resolving it', async () => {
    await expect(safeFetch('http://feeds.example/cal.ics', { requireHttps: true })).rejects.toThrow(
      new SsrfRejection('https required'),
    );
    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(mockSent).toHaveLength(0);
  });

  it('refuses a redirect to plain http, even one that leads back to https', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockRoutes.set('https://feeds.example/cal.ics', {
      status: 301,
      location: 'http://feeds.example/cal.ics',
    });
    mockRoutes.set('http://feeds.example/cal.ics', {
      status: 301,
      location: 'https://cdn.example/cal.ics',
    });

    await expect(
      safeFetch('https://feeds.example/cal.ics', { requireHttps: true }),
    ).rejects.toThrow(/https required: redirect/);
    expect(mockSent.map((hop) => hop.url)).toEqual(['https://feeds.example/cal.ics']);
  });

  it('follows an all-https chain', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockRoutes.set('https://feeds.example/cal.ics', {
      status: 302,
      location: 'https://cdn.example/cal.ics',
    });

    const result = await safeFetch('https://feeds.example/cal.ics', { requireHttps: true });

    expect(result.finalUrl).toBe('https://cdn.example/cal.ics');
    expect(mockSent.map((hop) => hop.url)).toEqual([
      'https://feeds.example/cal.ics',
      'https://cdn.example/cal.ics',
    ]);
  });

  it('allows a plain-http hop when not asked', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockRoutes.set('https://feeds.example/cal.ics', {
      status: 302,
      location: 'http://cdn.example/cal.ics',
    });

    const result = await safeFetch('https://feeds.example/cal.ics');

    expect(result.finalUrl).toBe('http://cdn.example/cal.ics');
  });
});
