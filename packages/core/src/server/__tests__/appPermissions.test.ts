/**
 * Application roles from the app's side: `OxyServer.appPermissionsFor` and
 * `middleware.requireAppPermission`.
 *
 * The Oxy read is stubbed at `server.request` — the one primitive both forms go
 * through — so each case can say exactly what Oxy answered and assert exactly
 * what was asked, with which bearer.
 */

import { OxyApiError } from '../../OxyServices.errors';
import { OxyServer } from '../OxyServer';
import { OxyAppPermissionError, appPermissionErrorStatus } from '../appPermissions';

const APP_ID = 'app-mercaria';

interface FakeReq {
  path: string;
  headers: Record<string, string>;
  userId?: string | null;
  sessionId?: string | null;
  accessToken?: string;
  serviceApp?: unknown;
  oxyAppPermissions?: unknown;
}

function sessionReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return {
    path: '/internal/payments',
    headers: {},
    userId: 'user-1',
    sessionId: 'session-1',
    accessToken: 'bearer-1',
    ...overrides,
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function serverWith(
  answer: (url: string, options: unknown) => unknown,
  config: { appPermissionsCacheTtlMs?: number; applicationId?: string | undefined } = {},
) {
  const server = new OxyServer({
    baseURL: 'https://synthetic.invalid',
    applicationId: 'applicationId' in config ? config.applicationId : APP_ID,
    appPermissionsCacheTtlMs: config.appPermissionsCacheTtlMs,
  });
  const request = jest
    .spyOn(server as unknown as { request: jest.Mock }, 'request')
    .mockImplementation(async (_method: string, url: string, _data: unknown, options: unknown) =>
      answer(url, options),
    );
  return { server, request };
}

const holds =
  (...permissions: string[]) =>
  () => ({ applicationId: APP_ID, userId: 'operator-1', permissions });

async function run(
  middleware: (
    req: FakeReq,
    res: ReturnType<typeof fakeRes>,
    next: (e?: unknown) => void,
  ) => unknown,
  req: FakeReq,
) {
  const res = fakeRes();
  const next = jest.fn();
  await middleware(req, res, next);
  return { res, next };
}

describe('appPermissionsFor', () => {
  it("asks Oxy with the request's own bearer and answers for the operator", async () => {
    const { server, request } = serverWith(holds('payments.operate', 'catalog.operate'));
    const held = await server.appPermissionsFor(sessionReq());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('GET');
    expect(request.mock.calls[0]?.[1]).toBe(`/applications/${APP_ID}/roles/me`);
    expect(request.mock.calls[0]?.[3]).toEqual({
      cache: false,
      retry: false,
      headers: { Authorization: 'Bearer bearer-1' },
    });
    expect(held.operatorId).toBe('operator-1');
    expect(held.permissions).toEqual(['catalog.operate', 'payments.operate']);
    expect(held.has('payments.operate')).toBe(true);
    expect(held.has('guest.operate')).toBe(false);
  });

  it('reuses an answer within the TTL, per session, and `fresh` asks again', async () => {
    const { server, request } = serverWith(holds('payments.operate'));
    await server.appPermissionsFor(sessionReq());
    await server.appPermissionsFor(sessionReq());
    expect(request).toHaveBeenCalledTimes(1);

    // Another session of the same person is a different entry.
    await server.appPermissionsFor(sessionReq({ sessionId: 'session-2', accessToken: 'bearer-2' }));
    expect(request).toHaveBeenCalledTimes(2);

    // A revocation, seen by a fresh read — and the fresh answer replaces the cache.
    request.mockImplementation(async () => holds()());
    const fresh = await server.appPermissionsFor(sessionReq(), { fresh: true });
    expect(fresh.has('payments.operate')).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    const cached = await server.appPermissionsFor(sessionReq());
    expect(cached.has('payments.operate')).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const { server, request } = serverWith(holds('payments.operate'));
    await Promise.all([
      server.appPermissionsFor(sessionReq()),
      server.appPermissionsFor(sessionReq()),
      server.appPermissionsFor(sessionReq()),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a TTL of 0 asks every time; invalidate drops one person', async () => {
    const uncached = serverWith(holds('payments.operate'), { appPermissionsCacheTtlMs: 0 });
    await uncached.server.appPermissionsFor(sessionReq());
    await uncached.server.appPermissionsFor(sessionReq());
    expect(uncached.request).toHaveBeenCalledTimes(2);

    const { server, request } = serverWith(holds('payments.operate'));
    await server.appPermissionsFor(sessionReq());
    server.invalidateAppPermissions({ userId: 'someone-else' });
    await server.appPermissionsFor(sessionReq());
    expect(request).toHaveBeenCalledTimes(1);
    server.invalidateAppPermissions({ userId: 'operator-1' });
    await server.appPermissionsFor(sessionReq());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses a service-token request, delegated or not, without asking Oxy', async () => {
    const { server, request } = serverWith(holds('payments.operate'));
    await expect(
      server.appPermissionsFor(sessionReq({ serviceApp: { appId: 'other' } })),
    ).rejects.toMatchObject({ code: 'APP_PERMISSION_SESSION_REQUIRED' });
    await expect(server.appPermissionsFor(sessionReq({ sessionId: null }))).rejects.toMatchObject({
      code: 'APP_PERMISSION_SESSION_REQUIRED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed and never caches a failure', async () => {
    const { server, request } = serverWith(() => {
      throw new OxyApiError('down', { status: 502 });
    });
    await expect(server.appPermissionsFor(sessionReq())).rejects.toMatchObject({
      code: 'APP_PERMISSION_UNAVAILABLE',
    });
    request.mockImplementation(async () => holds('payments.operate')());
    expect((await server.appPermissionsFor(sessionReq())).has('payments.operate')).toBe(true);
  });

  it('maps Oxy refusals: 404 is a misconfigured id, 403 a foreign session, 401 no session', async () => {
    for (const [status, code] of [
      [404, 'APP_PERMISSION_NOT_CONFIGURED'],
      [403, 'APP_PERMISSION_DENIED'],
      [401, 'APP_PERMISSION_SESSION_REQUIRED'],
    ] as const) {
      const { server } = serverWith(() => {
        throw new OxyApiError('refused', { status });
      });
      await expect(server.appPermissionsFor(sessionReq())).rejects.toMatchObject({ code });
    }
  });

  it('refuses an answer about another application or a malformed one', async () => {
    const other = serverWith(() => ({ applicationId: 'app-other', userId: 'u', permissions: [] }));
    await expect(other.server.appPermissionsFor(sessionReq())).rejects.toMatchObject({
      code: 'APP_PERMISSION_UNAVAILABLE',
    });
    const malformed = serverWith(() => ({
      applicationId: APP_ID,
      userId: 'u',
      permissions: ['app:update'],
    }));
    await expect(malformed.server.appPermissionsFor(sessionReq())).rejects.toMatchObject({
      code: 'APP_PERMISSION_UNAVAILABLE',
    });
  });

  it('with no configured id and no service credential, it is a deploy fault', async () => {
    const { server, request } = serverWith(holds('payments.operate'), {
      applicationId: undefined,
    });
    await expect(server.appPermissionsFor(sessionReq())).rejects.toMatchObject({
      code: 'APP_PERMISSION_NOT_CONFIGURED',
    });
    expect(request).not.toHaveBeenCalled();
    // An explicit id per call works without configuration.
    await expect(
      server.appPermissionsFor(sessionReq(), { applicationId: APP_ID }),
    ).resolves.toMatchObject({ applicationId: APP_ID });
  });
});

describe('middleware.requireAppPermission', () => {
  it('admits a holder and leaves the answer on the request', async () => {
    const { server } = serverWith(holds('payments.operate'));
    const req = sessionReq();
    const { res, next } = await run(
      server.middleware.requireAppPermission('payments.operate'),
      req,
    );
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(0);
    expect(req.oxyAppPermissions).toMatchObject({ operatorId: 'operator-1' });
  });

  it('answers 404 by default — to a non-holder AND to a request with no session', async () => {
    const { server } = serverWith(holds('catalog.operate'));
    const guard = server.middleware.requireAppPermission('payments.operate');

    const denied = await run(guard, sessionReq());
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.statusCode).toBe(404);
    expect(denied.res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });

    const anonymous = await run(guard, sessionReq({ userId: null, accessToken: undefined }));
    expect(anonymous.res.statusCode).toBe(404);
  });

  it('with deny 403 states the refusal, and 401 without a session', async () => {
    const { server } = serverWith(holds());
    const guard = server.middleware.requireAppPermission('payments.operate', { deny: 403 });
    expect((await run(guard, sessionReq())).res.statusCode).toBe(403);
    expect((await run(guard, sessionReq({ accessToken: undefined }))).res.statusCode).toBe(401);
  });

  it('answers 503 when Oxy cannot answer, in either deny mode', async () => {
    const { server } = serverWith(() => {
      throw new OxyApiError('down', { status: 500 });
    });
    const guard = server.middleware.requireAppPermission('payments.operate');
    const { res, next } = await run(guard, sessionReq());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it('`respond: false` hands a typed error to next', async () => {
    const { server } = serverWith(holds());
    const guard = server.middleware.requireAppPermission('payments.operate', { respond: false });
    const { res, next } = await run(guard, sessionReq());
    expect(res.statusCode).toBe(0);
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(OxyAppPermissionError);
    expect(error).toMatchObject({ code: 'APP_PERMISSION_DENIED', permission: 'payments.operate' });
    expect(appPermissionErrorStatus(error as OxyAppPermissionError)).toBe(404);
    expect(appPermissionErrorStatus(error as OxyAppPermissionError, 403)).toBe(403);
  });

  it('`fresh` asks Oxy on every request', async () => {
    const { server, request } = serverWith(holds('payments.operate'));
    const guard = server.middleware.requireAppPermission('payments.operate', { fresh: true });
    await run(guard, sessionReq());
    await run(guard, sessionReq());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses at mount time a key that could never be held', () => {
    const { server } = serverWith(holds());
    expect(() => server.middleware.requireAppPermission('payments:operate')).toThrow(
      'not an application permission key',
    );
    expect(() => server.middleware.requireAppPermission('payments')).toThrow();
    expect(() =>
      server.middleware.requireAppPermission('payments.operate', {
        deny: 401 as unknown as 404,
      }),
    ).toThrow('deny');
  });
});
