import type { Request, Response } from 'express';
import { verifyCsrfToken } from '../csrf';

const mockWarn = jest.fn();

jest.mock('../../utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function createResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function runVerify(req: Partial<Request>) {
  const res = createResponse();
  const next = jest.fn();

  verifyCsrfToken(
    {
      method: 'POST',
      headers: {},
      cookies: {},
      path: '/users/target/follow',
      ip: '127.0.0.1',
      ...req,
    } as Request,
    res,
    next,
  );

  return { res, next };
}

describe('verifyCsrfToken', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  /**
   * The batch profile read. Its route contract accepts an ANONYMOUS caller and
   * returns exactly the already-public `GET /users/:id` payload, so there is no
   * state for a cross-site POST to change — but CSRF gates the VERB, and a
   * signed-out or cookie-less client was getting a 403 on a read. Measured on
   * production before the fix: 2,730 `CSRF token missing` rejections on this
   * path in 24 hours, every one of them a batch lookup that then fell back to
   * resolving profiles one at a time.
   */
  it('allows the anonymous batch profile READ with no cookie and no header', () => {
    const { res, next } = runVerify({ baseUrl: '/users', path: '/by-ids' });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // The exemption is the whole route, mount included — a second router defining
  // its own `/by-ids` must not inherit it.
  it('still protects a same-named route under a different mount', () => {
    const { res, next } = runVerify({ baseUrl: '/profiles', path: '/by-ids' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // And it is an exact match, not a prefix: a state-changing sibling that merely
  // starts with the same text stays protected.
  it('still protects a route whose path merely starts with an exempt one', () => {
    const { res, next } = runVerify({ baseUrl: '/users', path: '/by-ids/delete' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // A method change is a different route. `DELETE /users/by-ids` would be a
  // write, and the exemption must not follow the path across verbs.
  it('still protects the exempt path under a state-changing method', () => {
    const { res, next } = runVerify({ method: 'DELETE', baseUrl: '/users', path: '/by-ids' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows state-changing requests with an explicit bearer token and no CSRF header', () => {
    const { res, next } = runVerify({
      headers: {
        authorization: 'Bearer user-session-token',
      },
      cookies: {
        csrf_token: 'cookie-token',
      },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects cookie-authenticated requests when header and cookie tokens differ in length', () => {
    const { res, next } = runVerify({
      cookies: {
        csrf_token: 'short',
      },
      headers: {
        'x-csrf-token': 'much-longer-header-token-value',
      },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({
      message: 'Invalid CSRF token',
      code: 'CSRF_TOKEN_INVALID',
    });
  });

  it('still rejects cookie-authenticated state-changing requests without a CSRF header', () => {
    const { res, next } = runVerify({
      cookies: {
        csrf_token: 'cookie-token',
      },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({
      message: 'CSRF token missing',
      code: 'CSRF_TOKEN_MISSING',
    });
  });

  // Regression contract for the server-to-server bulk hydration endpoint
  // (`POST /users/by-ids`), which Mention calls with a SERVICE TOKEN in the
  // Authorization header and no cookie jar. The bearer skip MUST pass it, while
  // an ambient cookie-credentialed browser write to the same path with no CSRF
  // header MUST still be rejected. This locks the contract that lets Mention's
  // bulk path be safely re-enabled.
  describe('POST /users/by-ids (service-to-service contract)', () => {
    it('passes a service-token/bearer POST with no cookie and no CSRF header', () => {
      const { res, next } = runVerify({
        path: '/by-ids',
        headers: { authorization: 'Bearer service-token' },
        cookies: {},
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects a cookie-only POST to the same path with no CSRF header', () => {
      const { res, next } = runVerify({
        path: '/by-ids',
        headers: {},
        cookies: { csrf_token: 'cookie-token' },
      });

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toEqual({
        message: 'CSRF token missing',
        code: 'CSRF_TOKEN_MISSING',
      });
    });
  });
});
