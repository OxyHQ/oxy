import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
import {
  ExperimentalOwnedMutationCache,
  experimentalOwnerStorageKey,
  experimentalGuardMutationExecution,
} from '../../src/ui/hooks/experimentalOwnedMutationCache';

it('resumes only the exact owner, keeps other and unknown mutations, and permits them later', async () => {
  const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
  let current: typeof alice | null = alice;
  const cache = new ExperimentalOwnedMutationCache(() => current);
  const client = new QueryClient({ mutationCache: cache });
  const ran: string[] = [];
  const pending = {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: true,
    status: 'pending' as const,
    variables: undefined,
    submittedAt: 1,
  };
  const create = (name: string) =>
    cache.build(
      client,
      {
        mutationKey: [name],
        scope: { id: 'shared-scope' },
        mutationFn: async () => {
          ran.push(name);
        },
      },
      pending,
    );
  const oldUnknown = create('legacy-unknown');
  const forNate = create('nate');
  const forAlice = create('alice');
  cache.bindVerifiedRestored(forNate, nate);
  cache.bindVerifiedRestored(forAlice, alice);
  await cache.resumePausedMutations();
  expect(ran).toEqual(['alice']);
  expect(cache.getAll()).toEqual(expect.arrayContaining([oldUnknown, forNate]));
  expect(oldUnknown.state.isPaused).toBe(true);
  expect(forNate.state.isPaused).toBe(true);
  current = nate;
  await cache.resumePausedMutations();
  expect(ran).toEqual(['alice', 'nate']);
  expect(oldUnknown.state.isPaused).toBe(true);
  expect(cache.getAll()).toContain(oldUnknown);
  expect(experimentalOwnerStorageKey(alice)).not.toBe(experimentalOwnerStorageKey(nate));
  client.clear();
});

it('keeps a legacy unknown paused even when directly continued', async () => {
  const owner = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const cache = new ExperimentalOwnedMutationCache(() => owner);
  const client = new QueryClient({ mutationCache: cache });
  const fn = jest.fn();
  const mutation = cache.build(
    client,
    { mutationKey: ['legacy'], mutationFn: fn },
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
  void mutation.continue();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(fn).not.toHaveBeenCalled();
  expect(mutation.state.isPaused).toBe(true);
  expect(cache.getAll()).toContain(mutation);
  client.clear();
});

it('baseline: a subscriber can change owner between retryer eligibility and mutation execution', async () => {
  const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
  let current: typeof alice | null = null;
  const cache = new ExperimentalOwnedMutationCache(() => current);
  const client = new QueryClient({ mutationCache: cache });
  const seen: string[] = [];
  const mutation = cache.build(
    client,
    {
      mutationKey: ['queued'],
      mutationFn: async () => {
        seen.push(current?.actorId ?? 'none');
      },
    },
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
  cache.bindVerifiedRestored(mutation, alice);
  const pending = mutation.continue();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const unsubscribe = cache.subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'continue' &&
      current?.actorId === 'alice'
    )
      current = nate;
  });
  current = alice;
  await cache.resumePausedMutations();
  await pending;
  expect(seen).toEqual(['nate']);
  unsubscribe();
  client.clear();
});

it('waits at the executor after reentry and runs only when the original owner returns', async () => {
  const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
  let current: typeof alice | null = null;
  const ownerListeners = new Set<() => void>();
  const cache = new ExperimentalOwnedMutationCache(() => current);
  const client = new QueryClient({ mutationCache: cache });
  const seen: string[] = [];
  const guarded = experimentalGuardMutationExecution(
    alice,
    () => current,
    (fn) => {
      ownerListeners.add(fn);
      return () => ownerListeners.delete(fn);
    },
    async () => {
      seen.push(current?.actorId ?? 'none');
    },
  );
  const mutation = cache.build(
    client,
    { mutationKey: ['queued'], mutationFn: guarded.run },
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
  cache.bindVerifiedRestored(mutation, alice);
  const pending = mutation.continue();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const unsubscribe = cache.subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'continue' &&
      current?.actorId === 'alice'
    )
      current = nate;
  });
  current = alice;
  const resumed = cache.resumePausedMutations();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(seen).toEqual([]);
  expect(guarded.isWaiting()).toBe(true);
  expect(mutation.state.status).toBe('pending');
  // TanStack has already emitted `continue`; its ordinary paused-only persister
  // would omit this still-waiting mutation.
  expect(mutation.state.isPaused).toBe(false);
  current = alice;
  for (const listener of ownerListeners) listener();
  await resumed;
  await pending;
  expect(seen).toEqual(['alice']);
  expect(guarded.isWaiting()).toBe(false);
  unsubscribe();
  client.clear();
});

it('can restore an explicitly serialized waiter into owner quarantine without touching an old blob', async () => {
  const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
  let current = nate;
  const oldCache = new ExperimentalOwnedMutationCache(() => current);
  const oldClient = new QueryClient({ mutationCache: oldCache });
  const waiter = oldCache.build(
    oldClient,
    { mutationKey: ['send'], mutationFn: async () => undefined },
    {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      status: 'pending',
      variables: { message: 'queued' },
      submittedAt: 1,
    },
  );
  oldCache.bindVerifiedRestored(waiter, alice);
  const state = dehydrate(oldClient, {
    shouldDehydrateMutation: (mutation) => mutation === waiter,
  });
  const ownerBlob = JSON.stringify({
    version: 1,
    owner: alice,
    state: {
      ...state,
      mutations: state.mutations.map((mutation) => ({
        ...mutation,
        state: { ...mutation.state, isPaused: true },
      })),
    },
  });
  const storage = new Map([
    ['oxy_account_queries:org', 'legacy-with-no-actor'],
    [experimentalOwnerStorageKey(alice), ownerBlob],
  ]);
  oldClient.clear();
  const cache = new ExperimentalOwnedMutationCache(() => current);
  const client = new QueryClient({ mutationCache: cache });
  const ran: string[] = [];
  client.setMutationDefaults(['send'], {
    mutationFn: async () => {
      ran.push(current.actorId);
    },
  });
  const blob = JSON.parse(storage.get(experimentalOwnerStorageKey(alice)) ?? 'null');
  expect(blob.owner).toEqual(alice);
  hydrate(client, blob.state);
  const restored = cache.getAll()[0];
  cache.bindVerifiedRestored(restored, alice);
  await cache.resumePausedMutations();
  expect(ran).toEqual([]);
  expect(restored.state.isPaused).toBe(true);
  current = alice;
  await cache.resumePausedMutations();
  expect(ran).toEqual(['alice']);
  expect(storage.get('oxy_account_queries:org')).toBe('legacy-with-no-actor');
  client.clear();
});

it('baseline: replacing mutation options can remove an executor wrapper', async () => {
  const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
  const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
  let current: typeof alice | null = null;
  const cache = new ExperimentalOwnedMutationCache(() => current);
  const client = new QueryClient({ mutationCache: cache });
  const seen: string[] = [];
  const guarded = experimentalGuardMutationExecution(
    alice,
    () => current,
    () => () => {},
    async () => {
      seen.push('guarded');
    },
  );
  const mutation = cache.build(
    client,
    { mutationKey: ['send'], mutationFn: guarded.run },
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
  cache.bindVerifiedRestored(mutation, alice);
  mutation.setOptions({
    mutationKey: ['send'],
    mutationFn: async () => {
      seen.push(current?.actorId ?? 'none');
    },
  });
  const pending = mutation.continue();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const unsubscribe = cache.subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'continue' &&
      current?.actorId === 'alice'
    )
      current = nate;
  });
  current = alice;
  await cache.resumePausedMutations();
  await pending;
  expect(seen).toEqual(['nate']);
  unsubscribe();
  client.clear();
});
