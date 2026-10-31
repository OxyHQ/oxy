import { QueryClient } from '@tanstack/react-query';
import { ExperimentalContextBarrier } from '../../../core/src/session/experimentalContextBarrier';
import { createExperimentalOwnedPersistence } from '../../src/ui/hooks/experimentalOwnedPersistence';
import { experimentalOwnerStorageKey } from '../../src/ui/hooks/experimentalOwnedMutationCache';
import { ExperimentalOwnedMutationRegistry } from '../../src/ui/hooks/experimentalOwnedMutationRegistry';
import { ExperimentalQuarantinedMutationCache } from '../../src/ui/hooks/experimentalQuarantinedMutationCache';

const alice = { actorId: 'alice', accountId: 'org', sessionId: 'session-alice' };
const nate = { actorId: 'nate', accountId: 'org', sessionId: 'session-nate' };
const payloadCodec = {
  version: 1,
  encode: (value: unknown) => value,
  decode: (value: unknown) => value,
};

function decodeFixtureQuery(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as { key?: unknown; data?: unknown };
  if (
    Object.keys(value).some((key) => !['key', 'data'].includes(key)) ||
    typeof value.key !== 'string'
  )
    return null;
  if (typeof value.data === 'string') return { queryKey: ['private', value.key], data: value.data };
  if (!value.data || typeof value.data !== 'object') return null;
  const data = value.data as { actor?: unknown };
  if (Object.keys(data).some((key) => key !== 'actor') || typeof data.actor !== 'string')
    return null;
  return { queryKey: ['private', value.key], data: { actor: data.actor } };
}
const queryCodec = {
  root: 'private',
  version: 1,
  encode: (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => {
    const encoded = { key: query.queryKey[1], data: query.state.data };
    if (!decodeFixtureQuery(encoded)) throw new Error('Unsafe query fields');
    return encoded;
  },
  decode: decodeFixtureQuery,
};

function fixture(values = new Map<string, string>()) {
  let owner = alice;
  const cache = new ExperimentalQuarantinedMutationCache();
  const client = new QueryClient({ mutationCache: cache });
  const storage = {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const calls: string[] = [];
  const registry = new ExperimentalOwnedMutationRegistry(() => {
    const captured = owner;
    return {
      owner: captured,
      isCurrent: () => owner === captured,
      request: async () => {
        calls.push(owner.actorId);
        return {};
      },
    };
  });
  registry.register('send', {
    accepts: (payload) => !!payload && typeof payload === 'object',
    codec: payloadCodec,
    run: (payload, ctx) => ctx.request({ method: 'POST', url: '/send', data: payload }),
  });
  const persistence = createExperimentalOwnedPersistence({
    client,
    storage,
    registry,
    accountQueries: { roots: ['private'] },
    codecs: [queryCodec],
  });
  return {
    cache,
    client,
    storage,
    registry,
    persistence,
    calls,
    values,
    setOwner(next: typeof alice) {
      owner = next;
    },
  };
}

it('partitions queries and registered operations across actors and restart, preserving unknown work', async () => {
  const values = new Map([['oxy_account_queries:org', 'legacy-with-no-actor']]);
  const f = fixture(values);
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    f.client.setQueryData(['public', 'settings'], { shared: true });
    f.registry.enqueue('alice-operation', 'send', { text: 'hello' });
    const unknownFn = jest.fn();
    expect(() =>
      f.cache.build(f.client, { mutationKey: ['new-unregistered'], mutationFn: unknownFn }),
    ).toThrow('Unregistered mutations');
    const unknown = f.cache.build(
      f.client,
      { mutationKey: ['legacy'], mutationFn: unknownFn },
      {
        context: undefined,
        data: undefined,
        error: null,
        failureCount: 0,
        failureReason: null,
        isPaused: true,
        status: 'pending',
        variables: undefined,
        submittedAt: 1,
      },
    );
    f.setOwner(nate);
    await f.persistence.prepareCommit(alice, nate, () => true);
    expect(f.client.getQueryData(['private', 'inbox'])).toBeUndefined();
    expect(f.client.getQueryData(['public', 'settings'])).toEqual({ shared: true });
    f.client.setQueryData(['private', 'inbox'], { actor: 'nate' });
    await f.cache.resumePausedMutations();
    void unknown.continue();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(unknownFn).not.toHaveBeenCalled();
    expect(f.cache.getAll()).toContain(unknown);
    f.setOwner(alice);
    await f.persistence.prepareCommit(nate, alice, () => true);
    expect(f.client.getQueryData(['private', 'inbox'])).toEqual({ actor: 'alice' });
    expect(values.get('oxy_account_queries:org')).toBe('legacy-with-no-actor');
    expect(f.storage.getItem).not.toHaveBeenCalledWith('oxy_account_queries:org');
    const restart = fixture(values);
    try {
      await restart.persistence.prepareCommit(null, alice, () => true);
      expect(restart.client.getQueryData(['private', 'inbox'])).toEqual({ actor: 'alice' });
      restart.setOwner(nate);
      await expect(restart.registry.execute('alice-operation')).rejects.toThrow(
        'owner unavailable',
      );
      restart.setOwner(alice);
      await restart.registry.execute('alice-operation');
      expect(restart.calls).toEqual(['alice']);
      expect(values.get('oxy_account_queries:org')).toBe('legacy-with-no-actor');
      expect(values.has(experimentalOwnerStorageKey(nate))).toBe(true);
    } finally {
      restart.client.clear();
    }
  } finally {
    f.client.clear();
  }
});

it('stays closed if a query subscriber supersedes preparation during removal', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    let current = true;
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') current = false;
    });
    f.setOwner(nate);
    await expect(f.persistence.prepareCommit(alice, nate, () => current)).rejects.toThrow(
      'Context binding unavailable',
    );
    expect(current).toBe(false);
    unsubscribe();
    await f.persistence.prepareCommit(alice, nate, () => true);
    expect(f.client.getQueryData(['private', 'inbox'])).toBeUndefined();
  } finally {
    f.client.clear();
  }
});

it('discards an owner restore superseded while storage is waiting', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    let unblock!: () => void;
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const read = f.storage.getItem.getMockImplementation();
    f.storage.getItem.mockImplementation(async (key) => {
      if (key === experimentalOwnerStorageKey(nate)) {
        observed();
        await wait;
      }
      return read ? read(key) : null;
    });
    let current = true;
    f.setOwner(nate);
    const pending = f.persistence.prepareCommit(alice, nate, () => current);
    await started;
    current = false;
    unblock();
    await expect(pending).rejects.toThrow('Context binding unavailable');
    expect(f.client.getQueryData(['private', 'inbox'])).toBeUndefined();
    f.setOwner(alice);
    await f.persistence.prepareCommit(null, alice, () => true);
    expect(f.client.getQueryData(['private', 'inbox'])).toEqual({ actor: 'alice' });
  } finally {
    f.client.clear();
  }
});

it('prepares the owner snapshot before the real context gate opens', async () => {
  const f = fixture();
  let actor = 'alice';
  let token = 'old';
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'device', deviceSecret: 'secret' }),
    getAccessToken: () => token,
    setAccessToken: (value) => {
      token = value;
    },
    mint: async () => ({
      version: 1,
      deviceId: 'device',
      deviceSessionId: 'incarnation',
      revision: actor === 'alice' ? 1 : 2,
      contextId: `ctx-${actor}`,
      actorId: actor,
      accountId: 'org',
      sessionId: `session-${actor}`,
      accessToken: `token-${actor}`,
      expiresAt: '2099-01-01T00:00:00Z',
    }),
    readState: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeAccountId: 'org',
      accounts: [
        { accountId: 'org', sessionId: `session-${actor}`, authuser: 0, operatedByUserId: actor },
      ],
    }),
    readDirectory: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeContextId: `ctx-${actor}`,
      principals: [
        {
          id: `p-${actor}`,
          userId: actor,
          authuser: 0,
          user: { id: actor, username: actor },
          contexts: [
            {
              id: `ctx-${actor}`,
              accountId: 'org',
              kind: 'organization',
              relationship: 'member',
              account: { id: 'org', username: 'org' },
              onDevice: true,
              available: true,
              active: true,
              lastUsedAt: null,
            },
          ],
        },
      ],
    }),
    prepareCommit: f.persistence.prepareCommit,
  });
  try {
    expect(await gate.reconcile()).toBe(true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    const observations: Array<string | null> = [];
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') observations.push(gate.snapshot()?.actorId ?? null);
    });
    actor = 'nate';
    f.setOwner(nate);
    expect(await gate.reconcile()).toBe(true);
    expect(observations).toEqual([null]);
    expect(f.client.getQueryData(['private', 'inbox'])).toBeUndefined();
    expect(gate.snapshot()?.actorId).toBe('nate');
    unsubscribe();
  } finally {
    f.client.clear();
  }
});

it('baseline: a cache subscriber can read another old query during sequential removal', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'first'], 'alice-first');
    f.client.setQueryData(['private', 'second'], 'alice-second');
    const seen: unknown[] = [];
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') seen.push(f.client.getQueryData(['private', 'second']));
    });
    f.setOwner(nate);
    await f.persistence.prepareCommit(alice, nate, () => true);
    expect(seen).toContain('alice-second');
    unsubscribe();
  } finally {
    f.client.clear();
  }
});

it('refuses an unquarantined cache and a silent owner-blob write failure', async () => {
  const f = fixture();
  const unsafe = new QueryClient();
  const bad = createExperimentalOwnedPersistence({
    client: unsafe,
    storage: f.storage,
    registry: f.registry,
    accountQueries: { roots: ['private'] },
  });
  try {
    await expect(bad.prepareCommit(null, alice, () => true)).rejects.toThrow('quarantine');
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    f.storage.setItem.mockImplementationOnce(async () => {});
    f.setOwner(nate);
    await expect(f.persistence.prepareCommit(alice, nate, () => true)).rejects.toThrow(
      'not persisted',
    );
    expect(f.client.getQueryData(['private', 'inbox'])).toEqual({ actor: 'alice' });
  } finally {
    unsafe.clear();
    f.client.clear();
  }
});

it('rejects excluded bearer and holder fields before writing an owner blob', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'unsafe-profile'], {
      bearer: 'fixture-bearer',
      deviceSecret: 'fixture-holder-secret',
    });
    f.setOwner(nate);
    await expect(f.persistence.prepareCommit(alice, nate, () => true)).rejects.toThrow(
      'Query codec failed',
    );
    const key = experimentalOwnerStorageKey(alice);
    expect(key).not.toContain('fixture-bearer');
    expect(key).not.toContain('fixture-holder-secret');
    expect(f.values.has(key)).toBe(false);
  } finally {
    f.client.clear();
  }
});

it('does not persist a query without an explicit root codec', async () => {
  const f = fixture();
  const noCodecs = createExperimentalOwnedPersistence({
    client: f.client,
    storage: f.storage,
    registry: f.registry,
    accountQueries: { roots: ['private'] },
  });
  try {
    await noCodecs.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], {
      bearer: 'fixture-bearer',
      deviceSecret: 'fixture-holder-secret',
    });
    f.setOwner(nate);
    await noCodecs.prepareCommit(alice, nate, () => true);
    const raw = f.values.get(experimentalOwnerStorageKey(alice)) ?? '';
    expect(JSON.parse(raw).queries).toEqual([]);
    expect(raw).not.toContain('fixture-bearer');
    expect(raw).not.toContain('fixture-holder-secret');
  } finally {
    f.client.clear();
  }
});

it('does not expose values from codec exceptions', async () => {
  const f = fixture();
  const throwing = createExperimentalOwnedPersistence({
    client: f.client,
    storage: f.storage,
    registry: f.registry,
    accountQueries: { roots: ['private'] },
    codecs: [
      {
        root: 'private',
        version: 1,
        encode: () => {
          throw new Error('fixture-holder-secret');
        },
        decode: () => null,
      },
    ],
  });
  try {
    await throwing.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    f.setOwner(nate);
    await expect(throwing.prepareCommit(alice, nate, () => true)).rejects.toThrow(
      'Query codec failed',
    );
    expect(f.values.has(experimentalOwnerStorageKey(alice))).toBe(false);
  } finally {
    f.client.clear();
  }
});

it('baseline: a codec cannot recognize a secret placed in a field it explicitly permits', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], {
      actor: 'fixture-bearer-inside-permitted-string',
    });
    f.setOwner(nate);
    await f.persistence.prepareCommit(alice, nate, () => true);
    expect(f.values.get(experimentalOwnerStorageKey(alice))).toContain(
      'fixture-bearer-inside-permitted-string',
    );
  } finally {
    f.client.clear();
  }
});

it('leaves a previous owner blob intact when a codec rejects a new value', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    f.setOwner(nate);
    await f.persistence.prepareCommit(alice, nate, () => true);
    f.setOwner(alice);
    await f.persistence.prepareCommit(nate, alice, () => true);
    const key = experimentalOwnerStorageKey(alice);
    const before = f.values.get(key);
    f.client.setQueryData(['private', 'inbox'], { bearer: 'fixture-bearer' });
    f.setOwner(nate);
    await expect(f.persistence.prepareCommit(alice, nate, () => true)).rejects.toThrow(
      'Query codec failed',
    );
    expect(f.values.get(key)).toBe(before);
  } finally {
    f.client.clear();
  }
});

it('quarantines an owner blob using an unknown codec version without rewriting it', async () => {
  const key = experimentalOwnerStorageKey(alice);
  const raw = JSON.stringify({
    version: 2,
    owner: alice,
    queries: [
      { root: 'private', version: 99, payload: { key: 'inbox', data: { actor: 'alice' } } },
    ],
    registry: JSON.stringify({ version: 2, owner: alice, entries: [] }),
  });
  const values = new Map([[key, raw]]);
  const f = fixture(values);
  try {
    await expect(f.persistence.prepareCommit(null, alice, () => true)).rejects.toThrow(
      'Unknown query codec',
    );
    expect(values.get(key)).toBe(raw);
  } finally {
    f.client.clear();
  }
});

it('preserves an earlier experimental owner-blob format without guessing a migration', async () => {
  const key = experimentalOwnerStorageKey(alice);
  const raw = JSON.stringify({
    version: 1,
    owner: alice,
    queryState: { queries: [], mutations: [] },
    registry: '{}',
  });
  const values = new Map([[key, raw]]);
  const f = fixture(values);
  try {
    await expect(f.persistence.prepareCommit(null, alice, () => true)).rejects.toThrow(
      'Invalid owner snapshot',
    );
    expect(values.get(key)).toBe(raw);
  } finally {
    f.client.clear();
  }
});

it('does not overwrite an owner blob changed outside the local queue', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    f.client.setQueryData(['private', 'inbox'], { actor: 'alice' });
    const key = experimentalOwnerStorageKey(alice);
    const outside = JSON.stringify({ version: 2, owner: nate, queries: [], registry: '{}' });
    f.values.set(key, outside);
    f.setOwner(nate);
    await expect(f.persistence.prepareCommit(alice, nate, () => true)).rejects.toThrow(
      'changed externally',
    );
    expect(f.values.get(key)).toBe(outside);
  } finally {
    f.client.clear();
  }
});

it('baseline: two independent persistence queues can both verify while one overwrites the other', async () => {
  const values = new Map<string, string>();
  const first = fixture(values);
  const second = fixture(values);
  let release!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await first.persistence.prepareCommit(null, alice, () => true);
    await second.persistence.prepareCommit(null, alice, () => true);
    first.client.setQueryData(['private', 'inbox'], { actor: 'first' });
    second.client.setQueryData(['private', 'inbox'], { actor: 'second' });
    second.storage.setItem.mockImplementationOnce(async (key, value) => {
      observed();
      await wait;
      values.set(key, value);
    });
    const delayed = second.persistence.checkpoint(alice, () => true);
    await started;
    expect(await first.persistence.checkpoint(alice, () => true)).toBe(true);
    release();
    expect(await delayed).toBe(true);
    const raw = values.get(experimentalOwnerStorageKey(alice)) ?? '';
    expect(raw).toContain('second');
    expect(raw).not.toContain('first');
  } finally {
    first.client.clear();
    second.client.clear();
  }
});

it('rejects an owner-mismatched blob without deleting it or the unattributed legacy blob', async () => {
  const key = experimentalOwnerStorageKey(alice);
  const raw = JSON.stringify({
    version: 2,
    owner: nate,
    queries: [],
    registry: '{}',
  });
  const values = new Map([
    [key, raw],
    ['oxy_account_queries:org', 'legacy-with-no-actor'],
  ]);
  const f = fixture(values);
  try {
    await expect(f.persistence.prepareCommit(null, alice, () => true)).rejects.toThrow(
      'Invalid owner snapshot',
    );
    expect(values.get(key)).toBe(raw);
    expect(values.get('oxy_account_queries:org')).toBe('legacy-with-no-actor');
  } finally {
    f.client.clear();
  }
});

it('journals before sending, restores inflight work as ambiguous, and checkpoints completion', async () => {
  const f = fixture();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.registry.register('slow', {
    accepts: () => true,
    codec: payloadCodec,
    run: async () => {
      began();
      await wait;
      return {};
    },
  });
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    await f.registry.enqueueDurably('slow-operation', 'slow', {}, f.persistence.checkpoint);
    const queued = JSON.parse(f.values.get(experimentalOwnerStorageKey(alice)) ?? '{}');
    expect(JSON.parse(queued.registry).entries[0].status).toBe('queued');
    const pending = f.registry.executeDurably('slow-operation', f.persistence.checkpoint);
    await started;
    const written = JSON.parse(f.values.get(experimentalOwnerStorageKey(alice)) ?? '{}');
    expect(JSON.parse(written.registry).entries[0].status).toBe('inflight');
    const restart = fixture(f.values);
    restart.registry.register('slow', {
      accepts: () => true,
      codec: payloadCodec,
      run: async () => ({}),
    });
    try {
      await restart.persistence.prepareCommit(null, alice, () => true);
      expect(JSON.parse(restart.registry.serialize(alice)).entries[0].status).toBe('ambiguous');
      await expect(
        restart.registry.executeDurably('slow-operation', restart.persistence.checkpoint),
      ).rejects.toThrow('owner unavailable');
    } finally {
      restart.client.clear();
    }
    release();
    await pending;
    const completed = JSON.parse(f.values.get(experimentalOwnerStorageKey(alice)) ?? '{}');
    expect(JSON.parse(completed.registry).entries[0].status).toBe('completed');
  } finally {
    f.client.clear();
  }
});

it('does not send an operation if its pre-send checkpoint fails', async () => {
  const f = fixture();
  try {
    await f.persistence.prepareCommit(null, alice, () => true);
    await f.registry.enqueueDurably('operation', 'send', {}, f.persistence.checkpoint);
    f.storage.setItem.mockImplementationOnce(async () => {});
    await expect(f.registry.executeDurably('operation', f.persistence.checkpoint)).rejects.toThrow(
      'not persisted',
    );
    expect(f.calls).toEqual([]);
    expect(JSON.parse(f.registry.serialize(alice)).entries[0].status).toBe('ambiguous');
  } finally {
    f.client.clear();
  }
});
