import { OxyServices } from '../OxyServices';

const target = 'https://api.allo.you/socket.io/';
function token(account: string, seconds = 3600): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: account, sessionId: `session-${account}`, exp: Math.floor(Date.now() / 1000) + seconds })}.signature`;
}
function setup() {
  const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
  const linked = oxy.createLinkedClient({ baseURL: 'https://api.allo.you' });
  return {
    oxy,
    linked,
    close: () => {
      linked.dispose();
      oxy.dispose();
    },
  };
}

afterEach(() => jest.restoreAllMocks());
it('shares fresh preflight across socket handshakes without sending an HTTP request', async () => {
  const { oxy, linked, close } = setup();
  try {
    oxy.session.setAccessToken(token('alice', 1));
    const fresh = token('alice');
    const refresh = jest.fn(async () => fresh);
    oxy.http.setAuthRefreshHandler(refresh);
    const fetch = jest.spyOn(globalThis, 'fetch');
    expect(
      await Promise.all([
        linked.getAccessToken(target),
        linked.getAccessToken('wss://api.allo.you/socket.io/'),
      ]),
    ).toEqual([fresh, fresh]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    const bob = token('bob');
    oxy.session.setAccessToken(bob);
    expect(await linked.getAccessToken(target)).toBe(bob);
  } finally {
    close();
  }
});
it('refuses a foreign origin before refresh and never substitutes anonymous authority', async () => {
  const { oxy, linked, close } = setup();
  try {
    oxy.session.setAccessToken(token('alice', 1));
    const refresh = jest.fn(async () => token('alice'));
    oxy.http.setAuthRefreshHandler(refresh);
    await expect(linked.getAccessToken('https://foreign.example/socket')).rejects.toThrow(
      'configured API origin',
    );
    await expect(linked.getAccessToken('https://user:secret@api.allo.you/socket')).rejects.toThrow(
      'configured API origin',
    );
    for (const other of [
      'wss://foreign.example/socket',
      'ws://api.allo.you/socket',
      'https://api.allo.you:444/socket',
      'file:///socket',
    ])
      await expect(linked.getAccessToken(other)).rejects.toThrow('configured API origin');
    expect(refresh).not.toHaveBeenCalled();
    oxy.session.clear();
    const anonymous = jest.fn(async () => 'external-service-token');
    linked.client.setAnonymousAuthProvider(anonymous);
    await expect(linked.getAccessToken(target)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(anonymous).not.toHaveBeenCalled();
    linked.dispose();
    await expect(linked.getAccessToken(target)).rejects.toThrow('disposed');
  } finally {
    close();
  }
});
it.each(['switch', 'logout', 'gap', 'dispose'] as const)(
  'rejects a pending socket bearer after %s',
  async (change) => {
    const { oxy, linked, close } = setup();
    try {
      const stale = token('alice', 1);
      const bob = token('bob');
      oxy.session.setAccessToken(stale);
      let release!: (value: string) => void;
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      oxy.http.setAuthRefreshHandler(() => {
        started();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      });
      const pending = linked.getAccessToken(target);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await start;
      if (change === 'switch') oxy.session.setAccessToken(bob);
      else if (change === 'dispose') linked.dispose();
      else {
        oxy.session.clear();
        if (change === 'gap') oxy.session.setAccessToken(stale);
      }
      release(token('alice'));
      await assertion;
      if (change === 'switch') expect(oxy.session.accessToken).toBe(bob);
    } finally {
      close();
    }
  },
);
it('aborts one waiting handshake without cancelling another shared refresh', async () => {
  const { oxy, linked, close } = setup();
  try {
    oxy.session.setAccessToken(token('alice', 1));
    let release!: (value: string) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const refresh = jest.fn(() => {
      started();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    oxy.http.setAuthRefreshHandler(refresh);
    const controller = new AbortController();
    const cancelled = linked.getAccessToken(target, { signal: controller.signal });
    const assertion = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    const healthy = linked.getAccessToken(target);
    await start;
    controller.abort();
    await assertion;
    const fresh = token('alice');
    release(fresh);
    expect(await healthy).toBe(fresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    close();
  }
});
