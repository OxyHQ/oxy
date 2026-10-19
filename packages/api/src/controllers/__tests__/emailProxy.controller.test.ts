import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Request, Response as ExpressResponse } from 'express';
import { SsrfRejection } from '@oxy.so/core/server';
import { proxyResource, resetProxyCacheForTests } from '../emailProxy.controller';

const mockSafeFetch = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@oxy.so/core/server', () => ({
  ...jest.requireActual('@oxy.so/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

type MockResponse = {
  setHeader: jest.Mock;
  send: jest.Mock;
  status: jest.Mock;
  end: jest.Mock;
};

function makeReq(url: string): Request {
  // proxyResource only reads `req.query`; a partial Express Request is all it needs.
  return { query: { url } } as unknown as Request;
}

function makeRes(): MockResponse {
  const res = {
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn(),
    end: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function makeSafeFetchResult(
  status: number,
  body: Buffer,
  headers: Record<string, string> = { 'content-type': 'image/png' },
  finalUrl = 'https://cdn.example/image.png',
) {
  const response = Readable.from([body]) as IncomingMessage;
  response.statusCode = status;
  response.headers = headers;
  return {
    response,
    status,
    headers,
    finalUrl,
  };
}

describe('email proxy SSRF protections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects direct private network URLs before fetching', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('blocked host'));
    const res = makeRes();

    await expect(
      proxyResource(makeReq('http://127.0.0.1/internal.png'), res as unknown as ExpressResponse),
    ).rejects.toThrow('Private network URLs are not allowed');

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'http://127.0.0.1/internal.png',
      expect.objectContaining({ maxRedirects: 3 }),
    );
  });

  it('rejects hostnames that resolve to private network addresses before fetching', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('blocked metadata address'));
    const res = makeRes();

    await expect(
      proxyResource(
        makeReq('http://metadata.example/internal.png'),
        res as unknown as ExpressResponse,
      ),
    ).rejects.toThrow('Private network URLs are not allowed');

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects to private network URLs', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('redirect target blocked'));
    const res = makeRes();

    await expect(
      proxyResource(makeReq('http://public.example/redirect'), res as unknown as ExpressResponse),
    ).rejects.toThrow('Private network URLs are not allowed');

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'http://public.example/redirect',
      expect.objectContaining({ maxRedirects: 3 }),
    );
  });

  it('proxies allowed images via DNS-pinned safeFetch', async () => {
    mockSafeFetch.mockResolvedValue(
      makeSafeFetchResult(
        200,
        Buffer.from('x'.repeat(128)),
        { 'content-type': 'image/png' },
        'https://cdn.example/image.png',
      ),
    );
    const res = makeRes();

    await proxyResource(
      makeReq('https://public.example/redirect'),
      res as unknown as ExpressResponse,
    );

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://public.example/redirect',
      expect.objectContaining({
        maxRedirects: 3,
        headers: expect.objectContaining({
          'User-Agent': 'OxyMail/1.0 (Image Proxy)',
        }),
      }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('reports an upstream 404 as 404, never as a transparent GIF', async () => {
    // A sender avatar falls back to `https://<domain>/favicon.ico`, which is
    // emitted without probing. When that 404s, answering with the transparent
    // GIF is a *successful* image response: the client's onError never fires
    // and an invisible pixel is painted over the initials placeholder, leaving
    // an empty avatar. The GIF is only for a tracking pixel we blocked.
    mockSafeFetch.mockResolvedValue(
      makeSafeFetchResult(
        404,
        Buffer.alloc(0),
        { 'content-type': 'text/html' },
        'https://sender.example/favicon.ico',
      ),
    );
    const res = makeRes();

    await proxyResource(
      makeReq('https://sender.example/favicon.ico'),
      res as unknown as ExpressResponse,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'image/gif');
  });
});

describe('email proxy upstream failures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** An upstream that sends part of its body and then hangs up — a timeout mid-body. */
  function makeTruncatedResult(contentType: string, finalUrl: string) {
    const response = new Readable({ read() {} }) as IncomingMessage;
    response.push(Buffer.from('x'.repeat(512)));
    setImmediate(() => response.destroy());
    const headers = { 'content-type': contentType };
    response.statusCode = 200;
    response.headers = headers;
    return { response, status: 200, headers, finalUrl };
  }

  it('answers an image whose body never finished with the transparent GIF, not a 400', async () => {
    mockSafeFetch.mockResolvedValue(
      makeTruncatedResult('image/png', 'https://slow.example/banner.png'),
    );
    const res = makeRes();

    await proxyResource(
      makeReq('https://slow.example/banner.png'),
      res as unknown as ExpressResponse,
    );

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/gif');
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    expect(res.status).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Proxy request failed',
      expect.objectContaining({ url: 'https://slow.example/banner.png' }),
    );
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('answers a font whose body never finished as any failed font fetch: an empty 404', async () => {
    mockSafeFetch.mockResolvedValue(
      makeTruncatedResult('font/woff2', 'https://slow.example/brand.woff2'),
    );
    const res = makeRes();

    await proxyResource(
      makeReq('https://slow.example/brand.woff2'),
      res as unknown as ExpressResponse,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('logs a failed upstream fetch as a warning, not an error', async () => {
    mockSafeFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND tracker.example'));
    const res = makeRes();

    await proxyResource(
      makeReq('https://tracker.example/logo.png'),
      res as unknown as ExpressResponse,
    );

    expect(mockLoggerWarn).toHaveBeenCalledWith('Proxy request failed', {
      url: 'https://tracker.example/logo.png',
      error: 'getaddrinfo ENOTFOUND tracker.example',
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('answers an image whose fetch failed with the transparent GIF', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));
    const res = makeRes();

    await proxyResource(
      makeReq('https://unreachable.example/photo.png'),
      res as unknown as ExpressResponse,
    );

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/gif');
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers a font whose fetch failed with an empty 404, never the GIF', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));
    const res = makeRes();

    await proxyResource(
      makeReq('https://unreachable.example/brand.woff2'),
      res as unknown as ExpressResponse,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('refuses a body over the size limit as too large', async () => {
    mockSafeFetch.mockResolvedValue(
      makeSafeFetchResult(
        200,
        Buffer.alloc(10 * 1024 * 1024 + 1),
        { 'content-type': 'image/png' },
        'https://huge.example/poster.png',
      ),
    );
    const res = makeRes();

    await expect(
      proxyResource(makeReq('https://huge.example/poster.png'), res as unknown as ExpressResponse),
    ).rejects.toThrow('Resource too large');
    expect(res.send).not.toHaveBeenCalled();
  });
});

/**
 * Every answer the proxy gives, header for header and byte for byte, and the
 * same answer again when the same URL is asked twice. Each test uses URLs of
 * its own: the controller's cache is module state.
 */
describe('email proxy answers, exactly', () => {
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Ask for `url` and return what the response was told to do. */
  async function answer(url: string) {
    const res = makeRes();
    await proxyResource(makeReq(url), res as unknown as ExpressResponse);
    return {
      headers: res.setHeader.mock.calls,
      status: res.status.mock.calls,
      sent: res.send.mock.calls,
      ended: res.end.mock.calls,
    };
  }

  it('serves an image with its headers, then the same bytes from the cache', async () => {
    const url = 'https://pins.example/served.png';
    const body = Buffer.from('p'.repeat(256));
    mockSafeFetch.mockResolvedValueOnce(
      makeSafeFetchResult(200, body, { 'content-type': 'image/png' }, url),
    );

    const first = await answer(url);
    const second = await answer(url);

    const headers = (cache: 'MISS' | 'HIT') => [
      ['Content-Type', 'image/png'],
      ['Content-Length', 256],
      ['Cache-Control', 'public, max-age=86400, immutable'],
      ['Cross-Origin-Resource-Policy', 'cross-origin'],
      ['X-Cache', cache],
    ];
    expect(first).toEqual({ headers: headers('MISS'), status: [], sent: [[body]], ended: [] });
    expect(second).toEqual({ headers: headers('HIT'), status: [], sent: [[body]], ended: [] });
  });

  it('answers an upstream 404 with an empty 404 cached for an hour, every time', async () => {
    const url = 'https://pins.example/missing.png';
    mockSafeFetch.mockImplementation(async () =>
      makeSafeFetchResult(404, Buffer.alloc(0), { 'content-type': 'text/html' }, url),
    );

    const expected = {
      headers: [['Cache-Control', 'public, max-age=3600']],
      status: [[404]],
      sent: [],
      ended: [[]],
    };
    expect(await answer(url)).toEqual(expected);
    expect(await answer(url)).toEqual(expected);
  });

  it('answers a failed image fetch with the transparent GIF, every time', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));

    const expected = {
      headers: [
        ['Content-Type', 'image/gif'],
        ['Cache-Control', 'public, max-age=86400'],
        ['Cross-Origin-Resource-Policy', 'cross-origin'],
      ],
      status: [],
      sent: [[GIF]],
      ended: [],
    };
    expect(await answer('https://pins.example/down.png')).toEqual(expected);
    expect(await answer('https://pins.example/down.png')).toEqual(expected);
  });

  it('answers a failed font fetch with an empty 404 cached for a day, every time', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));

    const expected = {
      headers: [['Cache-Control', 'public, max-age=86400']],
      status: [[404]],
      sent: [],
      ended: [[]],
    };
    expect(await answer('https://pins.example/down.woff2')).toEqual(expected);
    expect(await answer('https://pins.example/down.woff2')).toEqual(expected);
  });

  it('answers a tracking-sized image with the transparent GIF, every time', async () => {
    const url = 'https://pins.example/tiny.png';
    mockSafeFetch.mockImplementation(async () =>
      makeSafeFetchResult(200, Buffer.from('x'.repeat(42)), { 'content-type': 'image/png' }, url),
    );

    const expected = {
      headers: [
        ['Content-Type', 'image/gif'],
        ['Cache-Control', 'public, max-age=86400'],
        ['Cross-Origin-Resource-Policy', 'cross-origin'],
      ],
      status: [],
      sent: [[GIF]],
      ended: [],
    };
    expect(await answer(url)).toEqual(expected);
    expect(await answer(url)).toEqual(expected);
  });

  it('refuses a resource that is not an image or a font, every time', async () => {
    const url = 'https://pins.example/page.png';
    mockSafeFetch.mockImplementation(async () =>
      makeSafeFetchResult(200, Buffer.from('<html>'), { 'content-type': 'text/html' }, url),
    );

    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      await expect(
        proxyResource(makeReq(url), res as unknown as ExpressResponse),
      ).rejects.toMatchObject({
        name: 'BadRequestError',
        message: 'Only images and fonts allowed',
      });
      expect(res.setHeader).not.toHaveBeenCalled();
    }
  });

  it('refuses a private network URL, every time', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('blocked host'));

    for (let i = 0; i < 2; i++) {
      await expect(
        proxyResource(makeReq('http://10.0.0.9/pins.png'), makeRes() as unknown as ExpressResponse),
      ).rejects.toMatchObject({
        name: 'BadRequestError',
        message: 'Private network URLs are not allowed',
      });
    }
  });
});

/**
 * Fetches the proxy does not repeat: a resource asked for twice at once is
 * fetched once, one that could not be served is answered again from memory for
 * five minutes, and the cache evicts what was least recently used.
 */
describe('email proxy fetches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeFetch.mockReset();
    resetProxyCacheForTests();
  });

  afterAll(() => {
    resetProxyCacheForTests();
  });

  async function answer(url: string) {
    const res = makeRes();
    await proxyResource(makeReq(url), res as unknown as ExpressResponse);
    return {
      headers: res.setHeader.mock.calls,
      status: res.status.mock.calls,
      sent: res.send.mock.calls,
      ended: res.end.mock.calls,
    };
  }

  const image = (url: string, size = 200) =>
    makeSafeFetchResult(200, Buffer.from('i'.repeat(size)), { 'content-type': 'image/png' }, url);

  it('fetches a resource asked for twice at once only once, and answers both the same', async () => {
    const url = 'https://fetches.example/shared.png';
    let respond!: () => void;
    mockSafeFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = () => resolve(image(url));
        }),
    );

    const both = Promise.all([answer(url), answer(url)]);
    await new Promise((resolve) => setImmediate(resolve));
    respond();
    const [first, second] = await both;

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.headers).toContainEqual(['X-Cache', 'MISS']);
    // The fetch filled the cache for whoever asks next.
    expect((await answer(url)).headers).toContainEqual(['X-Cache', 'HIT']);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches a failing resource asked for twice at once only once', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));

    const [first, second] = await Promise.all([
      answer('https://fetches.example/down-together.png'),
      answer('https://fetches.example/down-together.png'),
    ]);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.headers).toContainEqual(['Content-Type', 'image/gif']);
  });

  it.each([
    [
      'an upstream 404',
      () => mockSafeFetch.mockResolvedValue(makeSafeFetchResult(404, Buffer.alloc(0))),
    ],
    ['a failed fetch', () => mockSafeFetch.mockRejectedValue(new Error('socket hang up'))],
    [
      'a tracking-sized image',
      () => mockSafeFetch.mockResolvedValue(image('https://x.example/a.png', 8)),
    ],
  ])('answers %s again without fetching it again', async (name, upstream) => {
    upstream();
    const url = `https://fetches.example/${name.replace(/\W+/g, '-')}.png`;

    const first = await answer(url);
    const second = await answer(url);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('refuses a refused resource again without fetching it again', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('blocked host'));

    for (let i = 0; i < 2; i++) {
      await expect(
        proxyResource(
          makeReq('http://10.0.0.10/again.png'),
          makeRes() as unknown as ExpressResponse,
        ),
      ).rejects.toMatchObject({
        name: 'BadRequestError',
        message: 'Private network URLs are not allowed',
      });
    }
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches a failed resource again once five minutes have passed', async () => {
    const url = 'https://fetches.example/recovers.png';
    const now = jest.spyOn(Date, 'now');
    const start = Date.now();
    try {
      now.mockReturnValue(start);
      mockSafeFetch.mockRejectedValueOnce(new Error('socket hang up'));
      await answer(url);

      now.mockReturnValue(start + 5 * 60 * 1000 - 1);
      await answer(url);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 5 * 60 * 1000);
      mockSafeFetch.mockResolvedValueOnce(image(url));
      expect((await answer(url)).headers).toContainEqual(['X-Cache', 'MISS']);
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('forgets the oldest failure once five thousand are held', async () => {
    mockSafeFetch.mockRejectedValue(new Error('socket hang up'));
    for (let i = 0; i <= 5000; i++) {
      await answer(`https://fetches.example/many-${i}.png`);
    }
    expect(mockSafeFetch).toHaveBeenCalledTimes(5001);

    // The newest is still held; the first was dropped to make room for it.
    await answer('https://fetches.example/many-5000.png');
    expect(mockSafeFetch).toHaveBeenCalledTimes(5001);
    await answer('https://fetches.example/many-0.png');
    expect(mockSafeFetch).toHaveBeenCalledTimes(5002);
  });

  it('evicts the least recently used resource, not the least recently fetched', async () => {
    // Room for exactly ten 200-byte images (one entry may take a tenth).
    resetProxyCacheForTests(2000);
    mockSafeFetch.mockImplementation(async (url: string) => image(url));
    const a = 'https://fetches.example/lru-a.png';
    const b = 'https://fetches.example/lru-b.png';
    const c = 'https://fetches.example/lru-c.png';

    await answer(a);
    await answer(b);
    for (let i = 0; i < 8; i++) await answer(`https://fetches.example/lru-fill-${i}.png`);
    expect((await answer(a)).headers).toContainEqual(['X-Cache', 'HIT']);
    await answer(c);
    expect(mockSafeFetch).toHaveBeenCalledTimes(11);

    // `a` was used after `b`, so `b` made room for `c`.
    expect((await answer(a)).headers).toContainEqual(['X-Cache', 'HIT']);
    expect((await answer(c)).headers).toContainEqual(['X-Cache', 'HIT']);
    expect(mockSafeFetch).toHaveBeenCalledTimes(11);
    expect((await answer(b)).headers).toContainEqual(['X-Cache', 'MISS']);
    expect(mockSafeFetch).toHaveBeenCalledTimes(12);
  });
});
