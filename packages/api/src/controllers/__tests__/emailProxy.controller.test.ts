import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Request, Response as ExpressResponse } from 'express';
import { SsrfRejection } from '@oxyhq/core/server';
import { proxyResource } from '../emailProxy.controller';

const mockSafeFetch = jest.fn();

jest.mock('@oxyhq/core/server', () => ({
  ...jest.requireActual('@oxyhq/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
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

    await expect(proxyResource(makeReq('http://127.0.0.1/internal.png'), res as unknown as ExpressResponse)).rejects.toThrow(
      'Private network URLs are not allowed'
    );

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'http://127.0.0.1/internal.png',
      expect.objectContaining({ maxRedirects: 3 }),
    );
  });

  it('rejects hostnames that resolve to private network addresses before fetching', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('blocked metadata address'));
    const res = makeRes();

    await expect(proxyResource(makeReq('http://metadata.example/internal.png'), res as unknown as ExpressResponse)).rejects.toThrow(
      'Private network URLs are not allowed'
    );

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects to private network URLs', async () => {
    mockSafeFetch.mockRejectedValue(new SsrfRejection('redirect target blocked'));
    const res = makeRes();

    await expect(proxyResource(makeReq('http://public.example/redirect'), res as unknown as ExpressResponse)).rejects.toThrow(
      'Private network URLs are not allowed'
    );

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

    await proxyResource(makeReq('https://public.example/redirect'), res as unknown as ExpressResponse);

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
      makeSafeFetchResult(404, Buffer.alloc(0), { 'content-type': 'text/html' }, 'https://sender.example/favicon.ico'),
    );
    const res = makeRes();

    await proxyResource(makeReq('https://sender.example/favicon.ico'), res as unknown as ExpressResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'image/gif');
  });
});
