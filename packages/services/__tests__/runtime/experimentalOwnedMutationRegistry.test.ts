import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { OxyServices } from '../../../core/src/OxyServices';
import { ExperimentalOwnedMutationRegistry } from '../../src/ui/hooks/experimentalOwnedMutationRegistry';

const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
const fixtureCodec = {
  version: 1,
  encode: (value: unknown) => value,
  decode: (value: unknown) => value,
};
const jwt = (actor: string) =>
  `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: `s-${actor}`, exp: 4102444800 })).toString('base64url')}.s`;

function fixture() {
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens(jwt('alice'));
  let current = alice;
  let generation = 0;
  let ready = true;
  const gate = {
    invalidate() {
      generation++;
      ready = false;
    },
    lease() {
      if (!ready) throw new Error('closed');
      return generation;
    },
    isCurrent(value: number) {
      return ready && value === generation;
    },
  };
  oxy.experimentalSetContextGate(gate);
  const capture = () => {
    if (!ready) return null;
    const value = gate.lease();
    const owner = { ...current };
    return {
      owner,
      fixtureHolderSecret: 'fixture-holder-secret',
      fixtureBearer: jwt(owner.actorId),
      isCurrent: () =>
        gate.isCurrent(value) &&
        current.actorId === owner.actorId &&
        current.sessionId === owner.sessionId,
      request: (request: {
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        data?: unknown;
      }) => oxy.http.experimentalRequestForLease(request, gate, value),
    };
  };
  return {
    oxy,
    capture,
    switchTo(owner: typeof alice) {
      gate.invalidate();
      current = owner;
      oxy.http.experimentalInstallContextToken(jwt(owner.actorId));
      ready = true;
    },
  };
}

it('quarantines restored work for its original owner and preserves legacy blobs', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: { ok: true } }),
  }));
  globalThis.fetch = fetcher as typeof fetch;
  const f = fixture();
  const register = (registry: ExperimentalOwnedMutationRegistry) =>
    registry.register('send', {
      accepts: (payload) => !!payload && typeof payload === 'object',
      codec: fixtureCodec,
      run: (payload, context) =>
        context.request({
          method: 'POST',
          url: '/send',
          data: { payload, key: context.idempotencyKey },
        }),
    });
  try {
    const first = new ExperimentalOwnedMutationRegistry(f.capture);
    register(first);
    first.enqueue('operation-1', 'send', { text: 'hello' });
    expect(first.serialize(alice)).not.toContain('fixture-holder-secret');
    expect(first.serialize(alice)).not.toContain(jwt('alice'));
    const oldBlob = 'legacy-with-unknown-actor';
    const storage = new Map([
      ['legacy:org', oldBlob],
      ['owned:alice', first.serialize(alice)],
    ]);
    f.switchTo(nate);
    const restored = new ExperimentalOwnedMutationRegistry(f.capture);
    register(restored);
    const stored = storage.get('owned:alice');
    if (!stored) throw new Error('Missing owner blob');
    restored.restore(stored, alice);
    await expect(restored.execute('operation-1')).rejects.toThrow('owner unavailable');
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(restored.serialize(alice)).entries[0].status).toBe('queued');
    f.switchTo(alice);
    await restored.execute('operation-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${jwt('alice')}`);
    expect(storage.get('legacy:org')).toBe(oldBlob);
  } finally {
    f.oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('fences delayed sends and keeps ambiguous work without retrying under a new actor', async () => {
  const originalFetch = globalThis.fetch;
  const fetcher = jest.fn(async () => ({ ok: true, status: 200 }));
  globalThis.fetch = fetcher as typeof fetch;
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new ExperimentalOwnedMutationRegistry(f.capture);
  registry.register('send', {
    accepts: () => true,
    codec: fixtureCodec,
    run: async (_payload, ctx) => {
      await wait;
      return ctx.request({ method: 'POST', url: '/send' });
    },
  });
  try {
    registry.enqueue('operation-2', 'send', {});
    const pending = registry.execute('operation-2');
    f.switchTo(nate);
    release();
    await expect(pending).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(registry.serialize(alice)).entries[0].status).toBe('ambiguous');
    f.switchTo(alice);
    await expect(registry.execute('operation-2')).rejects.toThrow('owner unavailable');
  } finally {
    f.oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('keeps an explicit registry adapter through observer option updates', async () => {
  const f = fixture();
  const registry = new ExperimentalOwnedMutationRegistry(f.capture);
  let release!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = jest.fn(async () => {
    observed();
    await wait;
    return 'ok';
  });
  registry.register('send', { accepts: () => true, codec: fixtureCodec, run });
  registry.enqueue('operation-3', 'send', {});
  const client = new QueryClient();
  const adapter = () => registry.execute('operation-3');
  const observer = new MutationObserver(client, { mutationFn: adapter });
  try {
    const pending = observer.mutate(undefined);
    await started;
    observer.setOptions({ mutationFn: adapter, onSuccess: () => undefined });
    release();
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => registry.register('send', { accepts: () => true, run })).toThrow();
  } finally {
    client.clear();
    f.oxy.dispose();
  }
});

it('retains an ambiguous operation and suppresses commit when a response arrives after an owner change', async () => {
  const originalFetch = globalThis.fetch;
  let reply!: (value: unknown) => void;
  const fetcher = jest.fn(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  globalThis.fetch = fetcher as typeof fetch;
  const f = fixture();
  const commit = jest.fn();
  const registry = new ExperimentalOwnedMutationRegistry(f.capture);
  registry.register('send', {
    accepts: () => true,
    codec: fixtureCodec,
    run: (_payload, ctx) => ctx.request({ method: 'POST', url: '/send' }),
    commit,
  });
  try {
    registry.enqueue('operation-4', 'send', {});
    const pending = registry.execute('operation-4');
    for (let i = 0; i < 20 && !fetcher.mock.calls.length; i++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    f.switchTo(nate);
    reply({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: {} }),
    });
    await expect(pending).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(JSON.parse(registry.serialize(alice)).entries[0].status).toBe('ambiguous');
  } finally {
    f.oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});

it('requires a mutation codec and rejects fixture credential fields before serialization', () => {
  const f = fixture();
  try {
    const noCodec = new ExperimentalOwnedMutationRegistry(f.capture);
    noCodec.register('send', { accepts: () => true, run: async () => ({}) });
    noCodec.enqueue('missing-codec', 'send', { text: 'hello' });
    expect(() => noCodec.serialize(alice)).toThrow('codec is required');
    const strict = new ExperimentalOwnedMutationRegistry(f.capture);
    const decode = (value: unknown) => {
      if (!value || typeof value !== 'object' || Object.keys(value).some((key) => key !== 'text'))
        throw new Error('Unsafe mutation fields');
      return value;
    };
    strict.register('send', {
      accepts: () => true,
      run: async () => ({}),
      codec: { version: 1, encode: decode, decode },
    });
    strict.enqueue('unsafe', 'send', {
      text: 'hello',
      bearer: 'fixture-bearer',
      deviceSecret: 'fixture-holder-secret',
    });
    expect(() => strict.serialize(alice)).toThrow('Mutation codec failed');
  } finally {
    f.oxy.dispose();
  }
});
