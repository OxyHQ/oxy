import type { NextFunction, Request, Response } from 'express';
import { createOxyCors, createOxyOriginCheck, createOxySocketCors } from '../cors';

interface FakeResponse extends Response {
  __headers: Record<string, string>;
  __statusSent: number | null;
}

function makeRequest(method: string, origin?: string, acrHeaders?: string): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  if (acrHeaders !== undefined) headers['access-control-request-headers'] = acrHeaders;
  return { method, headers } as unknown as Request;
}

function makeResponse(): FakeResponse {
  const res = {
    __headers: {},
    __statusSent: null,
  } as FakeResponse;
  res.setHeader = jest.fn((name: string, value: string | number | readonly string[]) => {
    res.__headers[name] = String(value);
    return res;
  }) as unknown as Response['setHeader'];
  res.sendStatus = jest.fn((code: number) => {
    res.__statusSent = code;
    return res;
  }) as unknown as Response['sendStatus'];
  return res;
}

function makeNext(): NextFunction & jest.Mock {
  return jest.fn() as unknown as NextFunction & jest.Mock;
}

describe('@oxy.so/core/server createOxyCors', () => {
  it('allows the HTTPS Oxy apex family (apex + one-level subdomains) and echoes the exact origin', () => {
    const mw = createOxyCors();
    for (const origin of [
      'https://oxy.so',
      'https://auth.oxy.so',
      'https://api.oxy.so',
      'https://accounts.oxy.so',
      'https://console.oxy.so',
      'https://inbox.oxy.so',
    ]) {
      const req = makeRequest('GET', origin);
      const res = makeResponse();
      const next = makeNext();
      mw(req, res, next);
      expect(res.__headers['Access-Control-Allow-Origin']).toBe(origin);
      expect(res.__headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(res.__headers.Vary).toBe('Origin');
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('allows explicit appOrigins', () => {
    const mw = createOxyCors({ appOrigins: ['https://app.example.com', 'http://localhost:3000'] });
    for (const origin of ['https://app.example.com', 'http://localhost:3000']) {
      const req = makeRequest('GET', origin);
      const res = makeResponse();
      const next = makeNext();
      mw(req, res, next);
      expect(res.__headers['Access-Control-Allow-Origin']).toBe(origin);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('DENIES other origins — never reflects them, never wildcards', () => {
    const mw = createOxyCors({ appOrigins: ['https://app.example.com'] });
    for (const origin of [
      'https://evil.com',
      'https://oxy.so.evil.com', // suffix attack
      'https://notoxy.so', // different apex
      'https://example.com',
      'http://oxy.so',
      'http://auth.oxy.so',
      'https://deep.attacker-controlled.oxy.so',
      'https://api.oxy.so:8443',
    ]) {
      const req = makeRequest('GET', origin);
      const res = makeResponse();
      const next = makeNext();
      mw(req, res, next);
      expect(res.__headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(res.__headers['Access-Control-Allow-Origin']).not.toBe('*');
      expect(res.__headers['Access-Control-Allow-Origin']).not.toBe(origin);
      // request still passes to the app; the browser enforces the missing ACAO.
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('NEVER emits wildcard ACAO together with credentials', () => {
    const mw = createOxyCors({ allowCredentials: true });
    // Even an allowed origin gets the exact origin, never '*'.
    const req = makeRequest('GET', 'https://auth.oxy.so');
    const res = makeResponse();
    mw(req, res, makeNext());
    expect(res.__headers['Access-Control-Allow-Origin']).toBe('https://auth.oxy.so');
    expect(res.__headers['Access-Control-Allow-Origin']).not.toBe('*');
    expect(res.__headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('answers preflight (OPTIONS) for an allowed origin with 204 + method/header allows', () => {
    const mw = createOxyCors({ appOrigins: ['https://app.example.com'] });
    const req = makeRequest('OPTIONS', 'https://app.example.com', 'content-type, authorization');
    const res = makeResponse();
    const next = makeNext();
    mw(req, res, next);
    expect(res.__headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(res.__headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(res.__headers['Access-Control-Allow-Headers']).toBe('content-type, authorization');
    expect(res.__headers['Access-Control-Max-Age']).toBeDefined();
    expect(res.__statusSent).toBe(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('includes anonymous activity metadata in the default preflight headers', () => {
    const mw = createOxyCors({ appOrigins: ['https://app.example.com'] });
    const req = makeRequest('OPTIONS', 'https://app.example.com');
    const res = makeResponse();
    mw(req, res, makeNext());

    expect(res.__headers['Access-Control-Allow-Headers']).toContain('X-Oxy-Edge-Region');
    expect(res.__headers['Access-Control-Allow-Headers']).toContain('X-Oxy-Activity-Id');
  });

  it('answers preflight for a DENIED origin with 204 and NO CORS headers', () => {
    const mw = createOxyCors();
    const req = makeRequest('OPTIONS', 'https://evil.com');
    const res = makeResponse();
    const next = makeNext();
    mw(req, res, next);
    expect(res.__headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(res.__statusSent).toBe(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through same-origin / non-browser requests (no Origin header) without ACAO', () => {
    const mw = createOxyCors();
    const req = makeRequest('GET');
    const res = makeResponse();
    const next = makeNext();
    mw(req, res, next);
    expect(res.__headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('can disable credentials and still never wildcards', () => {
    const mw = createOxyCors({ allowCredentials: false });
    const req = makeRequest('GET', 'https://api.oxy.so');
    const res = makeResponse();
    mw(req, res, makeNext());
    expect(res.__headers['Access-Control-Allow-Origin']).toBe('https://api.oxy.so');
    expect(res.__headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });
});

describe('createOxyOriginCheck', () => {
  it('admits what createOxyCors admits, and nothing opaque', () => {
    const allowed = createOxyOriginCheck(['https://app.example.com', 'exp://localhost:8081']);
    expect(allowed('https://api.oxy.so')).toBe(true);
    expect(allowed('https://app.example.com')).toBe(true);
    expect(allowed('https://evil.example')).toBe(false);
    expect(allowed('http://api.oxy.so')).toBe(false);
    expect(allowed('exp://localhost:8081')).toBe(false);
    expect(allowed('null')).toBe(false);
  });
});

describe('createOxySocketCors', () => {
  const { cors, allowRequest } = createOxySocketCors({ appOrigins: ['https://app.example.com'] });
  const decide = (origin: string | undefined) =>
    new Promise<boolean | undefined>((resolve) =>
      cors.origin(origin, (_error, allow) => resolve(allow)),
    );
  const handshake = (origin: string | undefined) =>
    new Promise<boolean>((resolve) =>
      allowRequest({ headers: origin === undefined ? {} : { origin } }, (_error, ok) =>
        resolve(ok),
      ),
    );

  it('answers polling with the same allowlist, with credentials', async () => {
    expect(cors.credentials).toBe(true);
    await expect(decide('https://app.example.com')).resolves.toBe(true);
    await expect(decide('https://mention.oxy.so')).resolves.toBe(true);
    await expect(decide('https://evil.example')).resolves.toBe(false);
  });

  it('refuses a WebSocket handshake from another browser origin, admits a native client', async () => {
    await expect(handshake('https://evil.example')).resolves.toBe(false);
    await expect(handshake('https://app.example.com')).resolves.toBe(true);
    await expect(handshake(undefined)).resolves.toBe(true);
  });
});
