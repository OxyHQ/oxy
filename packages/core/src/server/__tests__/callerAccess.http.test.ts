/**
 * The requesting person, over a REAL socket: `OxyServer.asUser` / `withUser`,
 * `accountAccessFor`, `applicationAccessFor` and their middleware.
 *
 * A local HTTP server plays Oxy, so each case asserts what actually went over
 * the wire — which bearer, how many requests — rather than what a stub was
 * handed. That is the property these APIs exist for: the person's bearer and
 * nothing else, no response reused across requests, no outage read as "no".
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '../OxyServer';
import { OxyAccessError, accessErrorStatus } from '../callerAuthority';
import type { OxyUserClient } from '../userClient';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
}

let httpServer: http.Server;
let baseURL: string;
const seen: Seen[] = [];
let answer: (url: string) => { status: number; body: unknown } = () => ({ status: 404, body: {} });

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    });
    const { status, body } = answer(req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function server(config: { appPermissionsCacheTtlMs?: number } = {}) {
  return new OxyServer({ baseURL, enableRetry: false, ...config });
}

function sessionReq(overrides: Record<string, unknown> = {}) {
  return {
    path: '/dashboard',
    headers: {},
    userId: 'user-1',
    sessionId: 'session-1',
    accessToken: 'bearer-1',
    ...overrides,
  };
}

const ACCOUNT = {
  accountId: 'org-1',
  kind: 'organization',
  parentAccountId: null,
  account: { _id: 'org-1', username: 'org' },
  relationship: 'member',
  callerMembership: null,
  callerAccess: {
    role: 'admin',
    permissions: ['account:update', 'account:read'],
    status: 'active',
    source: 'inherited',
  },
  childCount: 0,
};

const APPLICATION = {
  _id: 'app-1',
  name: 'Shop',
  type: 'third_party',
  status: 'active',
  isOfficial: true,
  isInternal: false,
  ownerAccountId: 'org-1',
  callerMembership: {
    role: 'developer',
    permissions: ['app:read', 'webhooks:update'],
    source: 'account',
    ownerAccountId: 'org-1',
  },
};

function oxyAnswers(routes: Record<string, { status: number; body: unknown }>) {
  answer = (url) => routes[url] ?? { status: 404, body: { error: { code: 'not_found' } } };
}

describe('asUser / withUser', () => {
  it("sends the person's bearer, never touches the server's own session, and caches nothing", async () => {
    oxyAnswers({ '/accounts/org-1': { status: 200, body: { account: ACCOUNT } } });
    const oxy = server();
    const read = () => oxy.withUser(sessionReq(), (user) => user.accounts.get('org-1'));

    await expect(read()).resolves.toMatchObject({ accountId: 'org-1' });
    await read();

    expect(seen).toEqual([
      { method: 'GET', url: '/accounts/org-1', authorization: 'Bearer bearer-1' },
      { method: 'GET', url: '/accounts/org-1', authorization: 'Bearer bearer-1' },
    ]);
    expect(oxy.http.getAccessToken()).toBeNull();
  });

  it('never lets a caller-supplied credential ride along', async () => {
    oxyAnswers({ '/accounts/org-1': { status: 200, body: { account: ACCOUNT } } });
    await server().withUser(sessionReq(), (user) =>
      user.request('GET', '/accounts/org-1', undefined, {
        headers: { authorization: 'Bearer someone-else', 'x-trace': 't' },
      }),
    );
    expect(seen).toEqual([
      { method: 'GET', url: '/accounts/org-1', authorization: 'Bearer bearer-1' },
    ]);
  });

  it('disposes the client when the callback settles, success or failure', async () => {
    oxyAnswers({});
    const oxy = server();
    let escaped: OxyUserClient | undefined;
    await oxy.withUser('bearer-2', (user) => {
      escaped = user;
      expect(user.http.getAccessToken()).toBe('bearer-2');
    });
    expect(escaped?.http.getAccessToken()).toBeNull();
    // A reference that escaped the callback can no longer speak as the person.
    await expect(escaped?.accounts.get('org-1')).rejects.toThrow('disposed');
    expect(seen).toHaveLength(0);

    await expect(
      oxy.withUser('bearer-3', (user) => {
        escaped = user;
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(escaped?.http.getAccessToken()).toBeNull();
  });

  it('refuses a request with no person behind it', () => {
    const oxy = server();
    for (const source of [
      sessionReq({ serviceApp: { appId: 'other-app' }, accessToken: 'service-token' }),
      sessionReq({ accessToken: undefined }),
      '',
      'two words',
    ]) {
      expect(() => oxy.asUser(source)).toThrow(OxyAccessError);
      try {
        oxy.asUser(source);
      } catch (error) {
        expect((error as OxyAccessError).code).toBe('ACCESS_SESSION_REQUIRED');
      }
    }
  });

  it('inherits transport settings only', () => {
    const oxy = new OxyServer({ baseURL, requestTimeout: 1234, enableCache: true });
    const user = oxy.asUser('bearer-1');
    expect(user.config).toMatchObject({ baseURL, requestTimeout: 1234, enableCache: false });
    user.dispose();
  });
});

describe('accountAccessFor', () => {
  it("answers the caller's effective access, cached per session; fresh asks again", async () => {
    oxyAnswers({ '/accounts/org-1': { status: 200, body: { account: ACCOUNT } } });
    const oxy = server();
    const access = await oxy.accountAccessFor(sessionReq(), 'org-1');
    expect(access).toMatchObject({
      accountId: 'org-1',
      kind: 'organization',
      relationship: 'member',
      role: 'admin',
      source: 'inherited',
      permissions: ['account:read', 'account:update'],
    });
    expect(access.has('account:update')).toBe(true);
    expect(access.has('billing:manage')).toBe(false);

    await oxy.accountAccessFor(sessionReq(), 'org-1');
    expect(seen).toHaveLength(1);
    await oxy.accountAccessFor(sessionReq({ sessionId: 'session-2' }), 'org-1');
    expect(seen).toHaveLength(2);
    await oxy.accountAccessFor(sessionReq(), 'org-1', { fresh: true });
    expect(seen).toHaveLength(3);
    expect(seen.every((request) => request.authorization === 'Bearer bearer-1')).toBe(true);

    oxy.invalidateAppPermissions({ userId: 'user-1' });
    await oxy.accountAccessFor(sessionReq(), 'org-1');
    expect(seen).toHaveLength(4);
  });

  it.each([
    [401, 'ACCESS_SESSION_REQUIRED', 401],
    [403, 'ACCESS_DENIED', 403],
    [404, 'ACCESS_DENIED', 403],
    [500, 'ACCESS_UNAVAILABLE', 503],
    [502, 'ACCESS_UNAVAILABLE', 503],
  ])('maps Oxy %i to %s (status %i) and never caches it', async (status, code, mapped) => {
    oxyAnswers({ '/accounts/org-1': { status, body: { error: { code: 'x', message: 'x' } } } });
    const oxy = server();
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await oxy.accountAccessFor(sessionReq(), 'org-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OxyAccessError);
      expect((error as OxyAccessError).code).toBe(code);
      expect(accessErrorStatus(error as OxyAccessError)).toBe(mapped);
    }
    expect(seen).toHaveLength(2);
  });

  it('is unavailable, not a "no", when Oxy answers without the caller access', async () => {
    const { callerAccess: _omitted, ...withoutAccess } = ACCOUNT;
    oxyAnswers({ '/accounts/org-1': { status: 200, body: { account: withoutAccess } } });
    const error = await server()
      .accountAccessFor(sessionReq(), 'org-1')
      .catch((e: unknown) => e);
    expect((error as OxyAccessError).code).toBe('ACCESS_UNAVAILABLE');
  });

  it('refuses a service-token request without asking Oxy', async () => {
    const error = await server()
      .accountAccessFor(sessionReq({ serviceApp: { appId: 'x' } }), 'org-1')
      .catch((e: unknown) => e);
    expect((error as OxyAccessError).code).toBe('ACCESS_SESSION_REQUIRED');
    expect(seen).toHaveLength(0);
  });
});

describe('applicationAccessFor', () => {
  it('answers the owning-account access, owner and official flag', async () => {
    oxyAnswers({ '/applications/app-1': { status: 200, body: { application: APPLICATION } } });
    const access = await server().applicationAccessFor(sessionReq(), 'app-1');
    expect(access).toMatchObject({
      applicationId: 'app-1',
      ownerAccountId: 'org-1',
      official: true,
      status: 'active',
      role: 'developer',
      permissions: ['app:read', 'webhooks:update'],
    });
    expect(seen[0]?.authorization).toBe('Bearer bearer-1');
  });

  it.each([
    [{ type: 'first_party', isOfficial: false, isInternal: false }, true],
    [{ type: 'internal', isOfficial: false, isInternal: false }, true],
    [{ type: 'system', isOfficial: false, isInternal: false }, true],
    [{ type: 'third_party', isOfficial: false, isInternal: true }, true],
    [{ type: 'third_party', isOfficial: false, isInternal: false }, false],
  ])("is official by oxy-api's trust rule: %o -> %s", async (trust, official) => {
    oxyAnswers({
      '/applications/app-1': { status: 200, body: { application: { ...APPLICATION, ...trust } } },
    });
    const access = await server().applicationAccessFor(sessionReq(), 'app-1');
    expect(access.official).toBe(official);
  });

  it('answers a suspended application with its status', async () => {
    oxyAnswers({
      '/applications/app-1': {
        status: 200,
        body: { application: { ...APPLICATION, status: 'suspended' } },
      },
    });
    const access = await server().applicationAccessFor(sessionReq(), 'app-1');
    expect(access.status).toBe('suspended');
  });

  it.each([
    ['an unknown status', { status: 'archived' }],
    ['no type', { type: undefined }],
    ['no isInternal', { isInternal: undefined }],
  ])('is unavailable for %s', async (_case, broken) => {
    oxyAnswers({
      '/applications/app-1': { status: 200, body: { application: { ...APPLICATION, ...broken } } },
    });
    const error = await server()
      .applicationAccessFor(sessionReq(), 'app-1')
      .catch((e: unknown) => e);
    expect((error as OxyAccessError).code).toBe('ACCESS_UNAVAILABLE');
  });

  it('is unavailable when the membership names another owner', async () => {
    oxyAnswers({
      '/applications/app-1': {
        status: 200,
        body: {
          application: {
            ...APPLICATION,
            callerMembership: { ...APPLICATION.callerMembership, ownerAccountId: 'org-2' },
          },
        },
      },
    });
    const error = await server()
      .applicationAccessFor(sessionReq(), 'app-1')
      .catch((e: unknown) => e);
    expect((error as OxyAccessError).code).toBe('ACCESS_UNAVAILABLE');
  });
});

describe('middleware.requireApplicationAccess / requireAccountAccess', () => {
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

  async function run(
    middleware: ReturnType<OxyServer['middleware']['requireApplicationAccess']>,
    req: Record<string, unknown>,
  ) {
    const res = fakeRes();
    const next = jest.fn();
    await middleware(req as never, res as never, next);
    return { res, next };
  }

  it('admits a holder and puts the answer on the request', async () => {
    oxyAnswers({ '/applications/app-1': { status: 200, body: { application: APPLICATION } } });
    const gate = server().middleware.requireApplicationAccess('webhooks:update', {
      param: 'appId',
    });
    const req = sessionReq({ params: { appId: 'app-1' } });
    const { next } = await run(gate, req);
    expect(next).toHaveBeenCalledWith();
    expect(
      (req as { oxyApplicationAccess?: { ownerAccountId: string } }).oxyApplicationAccess,
    ).toMatchObject({ ownerAccountId: 'org-1' });
  });

  it('answers a non-holder, an outage and a missing session by outcome', async () => {
    const oxy = server();
    oxyAnswers({ '/applications/app-1': { status: 200, body: { application: APPLICATION } } });
    const lacks = await run(
      oxy.middleware.requireApplicationAccess('billing:manage', { param: 'appId' }),
      sessionReq({ params: { appId: 'app-1' } }),
    );
    expect(lacks.res.statusCode).toBe(403);
    expect(lacks.res.body).toEqual({ error: { code: 'forbidden', message: 'Not permitted' } });

    oxyAnswers({ '/applications/app-2': { status: 503, body: {} } });
    const outage = await run(
      oxy.middleware.requireApplicationAccess('app:read', { param: 'appId' }),
      sessionReq({ params: { appId: 'app-2' } }),
    );
    expect(outage.res.statusCode).toBe(503);

    const hidden = await run(
      oxy.middleware.requireAccountAccess('account:read', { param: 'accountId', deny: 404 }),
      sessionReq({ accessToken: undefined, params: { accountId: 'org-1' } }),
    );
    expect(hidden.res.statusCode).toBe(404);
    expect(hidden.next).not.toHaveBeenCalled();
  });

  it('hands the typed refusal to next() with respond: false', async () => {
    oxyAnswers({ '/accounts/org-1': { status: 200, body: { account: ACCOUNT } } });
    const { next } = await run(
      server().middleware.requireAccountAccess('billing:manage', {
        param: 'accountId',
        respond: false,
      }),
      sessionReq({ params: { accountId: 'org-1' } }),
    );
    const refusal = next.mock.calls[0]?.[0] as OxyAccessError;
    expect(refusal).toBeInstanceOf(OxyAccessError);
    expect(refusal.code).toBe('ACCESS_DENIED');
    expect(refusal.permission).toBe('billing:manage');
  });

  it('refuses bad configuration at mount time', () => {
    const oxy = server();
    expect(() => oxy.middleware.requireAccountAccess('', { param: 'id' })).toThrow();
    expect(() => oxy.middleware.requireAccountAccess('account:read', { param: '' })).toThrow();
    expect(() =>
      oxy.middleware.requireAccountAccess('account:read', { param: 'id', deny: 500 as never }),
    ).toThrow();
  });
});
