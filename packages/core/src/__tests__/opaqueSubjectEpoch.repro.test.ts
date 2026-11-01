import { OxyServices } from '../OxyServices';
import { createNativeAuthStateStore } from '../session/authStateStore';
import { refreshDeviceSecretArm } from '../session/refresh';

describe('opaque bearer subject and session epoch reproduction', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not send an opaque bearer as implicit HTTP authorization', async () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    const bearerA = 'synthetic-opaque-a';
    const bearerB = 'synthetic-opaque-b';
    let sentAuthorization = false;
    globalThis.fetch = jest.fn(async (_url, init) => {
      sentAuthorization = Boolean((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ data: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      oxy.session.setAccessToken(bearerA);
      const renderedAccount = 'A';
      const renderedEpoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(bearerB);
      const operationEpoch = oxy.http.getSessionEpoch();
      expect(operationEpoch).toBeGreaterThan(renderedEpoch);
      expect(oxy.session.userId).toBeNull();
      expect(await oxy.http.post('/action', { account: renderedAccount })).toBe('ok');
      expect(oxy.http.getSessionEpoch()).toBe(operationEpoch);
      expect(sentAuthorization).toBe(false);
    } finally {
      oxy.dispose();
    }
  });

  it('has identical synchronous observations for opaque B and rotated opaque A', () => {
    const observe = (replacement: string) => {
      const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
      try {
        oxy.session.setAccessToken('synthetic-opaque-a-before');
        const oldEpoch = oxy.http.getSessionEpoch();
        oxy.session.setAccessToken(replacement);
        return {
          isAuthenticated: oxy.session.isAuthenticated,
          userId: oxy.session.userId,
          epochDelta: oxy.http.getSessionEpoch() - oldEpoch,
          // Rendered viewer and device state have not projected the change.
          rendered: 'A',
          projectedDeviceAccount: 'A',
        };
      } finally {
        oxy.dispose();
      }
    };
    expect(observe('synthetic-opaque-a-after')).toEqual(observe('synthetic-opaque-b'));
  });

  it('can send a sub-only JWT while the session userId getter is unknown', async () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    const payload = Buffer.from(JSON.stringify({ sub: 'B', exp: 4102444800 })).toString(
      'base64url',
    );
    const candidate = `h.${payload}.s`;
    let sentCandidate = false;
    globalThis.fetch = jest.fn(async (_url, init) => {
      sentCandidate =
        (init?.headers as Record<string, string>).Authorization === `Bearer ${candidate}`;
      return new Response(JSON.stringify({ data: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      oxy.session.setAccessToken(candidate);
      expect(oxy.session.userId).toBeNull();
      expect(await oxy.http.post('/action', { account: 'A' })).toBe('ok');
      expect(sentCandidate).toBe(true);
    } finally {
      oxy.dispose();
    }
  });

  it('keeps the same epoch for distinct same-session JWT bytes', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    const makeToken = (nonce: number) => {
      const payload = Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'sA', nonce })).toString(
        'base64url',
      );
      return `h.${payload}.s`;
    };
    try {
      oxy.session.setAccessToken(makeToken(1));
      const epoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(makeToken(2));
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
    } finally {
      oxy.dispose();
    }
  });

  it('cannot bind a stale A projection by recapturing epoch during a later render', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    try {
      oxy.session.setAccessToken('synthetic-opaque-a');
      const viewer = 'A';
      oxy.session.setAccessToken('synthetic-opaque-b');
      // An unrelated render may happen after B's install but before the
      // asynchronous A -> B account projection has committed.
      const capturedDuringRender = oxy.http.getSessionEpoch();
      expect(viewer).toBe('A');
      expect(oxy.session.userId).toBeNull();
      expect(oxy.http.getSessionEpoch()).toBe(capturedDuringRender);
    } finally {
      oxy.dispose();
    }
  });

  it('also advances the epoch for a legitimate opaque rotation of A', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    try {
      oxy.session.setAccessToken('synthetic-opaque-a-before');
      const renderedEpoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken('synthetic-opaque-a-after');
      expect(oxy.http.getSessionEpoch()).toBeGreaterThan(renderedEpoch);
      expect(oxy.session.userId).toBeNull();
    } finally {
      oxy.dispose();
    }
  });

  it('indistinguishably advances the epoch when a real refresh receives A or B', async () => {
    const observe = async (account: 'A' | 'B') => {
      const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
      const values = new Map<string, string>();
      const store = createNativeAuthStateStore({
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          values.set(key, value);
        },
        removeItem: async (key) => {
          values.delete(key);
        },
      });
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      const initial = 'synthetic-opaque-a-before';
      await store.save({
        deviceId: 'device',
        deviceSecret: 'synthetic-holder',
        sessionId: 'sA',
        userId: 'A',
        accessToken: initial,
        expiresAt,
      });
      oxy.session.setAccessToken(initial);
      const before = oxy.http.getSessionEpoch();
      globalThis.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                accessToken: `synthetic-opaque-${account}-after`,
                expiresAt,
                nextDeviceSecret: 'synthetic-holder-next',
                state: {
                  deviceId: 'device',
                  revision: 2,
                  updatedAt: Date.now(),
                  activeAccountId: account,
                  accounts: [
                    { accountId: 'A', sessionId: 'sA', authuser: 0 },
                    { accountId: 'B', sessionId: 'sB', authuser: 1 },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
      try {
        const result = await refreshDeviceSecretArm({ oxy, store });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('Expected fixture mint');
        expect(result.userId).toBe(account);
        return {
          epochDelta: oxy.http.getSessionEpoch() - before,
          userId: oxy.session.userId,
          isAuthenticated: oxy.session.isAuthenticated,
          rendered: 'A',
          projectedDeviceAccount: 'A',
        };
      } finally {
        oxy.dispose();
      }
    };
    expect(await observe('A')).toEqual(await observe('B'));
  });
});
