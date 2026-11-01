import { OxyServices } from '../OxyServices';

function jwt(claims: Record<string, unknown>, jti: string): string {
  return `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: 's1', exp: 4102444800, jti, ...claims })).toString('base64url')}.s`;
}
const alice = { act: { sub: 'alice' }, device_context_id: 'ctx-a', device_session_id: 'device-a' };
const bob = { act: { sub: 'bob' }, device_context_id: 'ctx-b', device_session_id: 'device-b' };
const response = (value: string) =>
  new Response(JSON.stringify({ data: value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('HTTP actor and context transitions', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ['actor', { ...alice, act: bob.act }],
    ['context', { ...alice, device_context_id: bob.device_context_id }],
    ['device session', { ...alice, device_session_id: bob.device_session_id }],
  ])(
    'invalidates cached responses for a changed %s with the same user and session',
    async (_label, next) => {
      const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce(response('old'))
        .mockResolvedValueOnce(response('new'));
      try {
        oxy.session.setAccessToken(jwt(alice, '1'));
        const epoch = oxy.http.getSessionEpoch();
        expect(await oxy.http.get('/private')).toBe('old');
        oxy.session.setAccessToken(jwt(next, '2'));
        expect(oxy.http.getSessionEpoch()).toBe(epoch + 1);
        expect(await oxy.http.get('/private')).toBe('new');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      } finally {
        oxy.dispose();
      }
    },
  );

  it('preserves the same-context rotation and the cache', async () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    globalThis.fetch = jest.fn().mockResolvedValue(response('same'));
    try {
      oxy.session.setAccessToken(jwt(alice, '1'));
      const epoch = oxy.http.getSessionEpoch();
      expect(await oxy.http.get('/private')).toBe('same');
      oxy.session.setAccessToken(jwt(alice, '2'));
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
      expect(await oxy.http.get('/private')).toBe('same');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      oxy.dispose();
    }
  });

  it('remembers known context through an old token with absent claims', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    try {
      oxy.session.setAccessToken(jwt(alice, '1'));
      const epoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(jwt({}, '2'));
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
      oxy.session.setAccessToken(jwt(bob, '3'));
      expect(oxy.http.getSessionEpoch()).toBe(epoch + 1);
    } finally {
      oxy.dispose();
    }
  });

  it('does not infer an unknown prior actor from the subject', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    try {
      oxy.session.setAccessToken(jwt({}, '1'));
      const epoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(jwt(bob, '2'));
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
    } finally {
      oxy.dispose();
    }
  });

  it.each([null, '', 42, { sub: null }, { sub: 42 }])(
    'does not forget a known actor when an intervening claim is malformed: %j',
    (malformed) => {
      const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
      try {
        oxy.session.setAccessToken(jwt({ act: alice.act }, '1'));
        const epoch = oxy.http.getSessionEpoch();
        oxy.session.setAccessToken(jwt({ act: malformed }, '2'));
        expect(oxy.http.getSessionEpoch()).toBe(epoch);
        oxy.session.setAccessToken(jwt({ act: bob.act }, '3'));
        expect(oxy.http.getSessionEpoch()).toBe(epoch + 1);
      } finally {
        oxy.dispose();
      }
    },
  );

  it('does not carry a previous owner hint across an explicit signout', () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    try {
      oxy.session.setAccessToken(jwt(alice, '1'));
      oxy.session.clear();
      const epoch = oxy.http.getSessionEpoch();
      oxy.session.setAccessToken(jwt({}, '2'));
      oxy.session.setAccessToken(jwt(bob, '3'));
      expect(oxy.http.getSessionEpoch()).toBe(epoch);
    } finally {
      oxy.dispose();
    }
  });

  it('fences a linked-client response across a same-subject context ABA', async () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    const linked = oxy.createLinkedClient({ baseURL: 'https://product.invalid' });
    let release!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = jest.fn(() => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    try {
      const a = jwt(alice, '1');
      oxy.session.setAccessToken(a);
      const pending = linked.client.get('/private');
      const rejected = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await entered;
      oxy.session.setAccessToken(jwt(bob, '2'));
      oxy.session.setAccessToken(a);
      release(response('stale'));
      await rejected;
    } finally {
      linked.dispose();
      oxy.dispose();
    }
  });

  it('synchronizes the provider before sending after a reentrant token listener', async () => {
    const oxy = new OxyServices({ baseURL: 'https://test.invalid' });
    const a = jwt(alice, '1');
    const b = jwt(bob, '2');
    const c = jwt({ ...bob, act: { sub: 'charlie' } }, '3');
    oxy.session.setAccessToken(a);
    const unsubscribe = oxy.session.onChange((next) => {
      if (next === b) oxy.session.setAccessToken(c);
    });
    const linked = oxy.createLinkedClient({ baseURL: 'https://product.invalid' });
    let sent: string | undefined;
    globalThis.fetch = jest.fn(async (_url, init) => {
      sent = (init?.headers as Record<string, string>).Authorization;
      return response('current');
    });
    try {
      oxy.session.setAccessToken(b);
      expect(oxy.session.accessToken).toBe(c);
      // Token listeners are reentrant; the old callback can leave this local
      // getter stale until the linked provider is synchronized at request time.
      expect(linked.client.getAccessToken()).toBe(b);
      expect(await linked.client.get('/private')).toBe('current');
      expect(sent).toBe(`Bearer ${c}`);
    } finally {
      unsubscribe();
      linked.dispose();
      oxy.dispose();
    }
  });
});
