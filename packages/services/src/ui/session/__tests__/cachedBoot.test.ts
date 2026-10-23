import type { User } from '@oxy.so/core';
import type { AuthStateStore, PersistedAuthState } from '@oxy.so/core/session';
import { createCachedBootStore } from '../cachedBoot';
import { createMemoryStorage } from '../../utils/storageHelpers';

function authStore(state: PersistedAuthState): AuthStateStore {
  return {
    load: async () => state,
    save: async () => true,
    clear: async () => undefined,
  };
}

it('offers a cached session only for the account the saved session belongs to', async () => {
  const cache = createCachedBootStore(createMemoryStorage(), 'oxy_session');
  const saved = { sessionId: 's1', userId: 'u1', deviceId: 'd1', deviceSecret: 'secret' };
  await cache.saveLane('client', 'device');
  await cache.saveAccount({ id: 'u2', username: 'other' } as User);

  expect(await cache.readSession('client', authStore(saved))).toBeNull();

  await cache.saveAccount({ id: 'u1', username: 'me' } as User);
  expect(await cache.readSession('client', authStore(saved))).toMatchObject({
    sessionId: 's1',
    user: { id: 'u1' },
    warmToken: null,
  });
  // Another app's classification, or an OAuth-only one, never paints.
  expect(await cache.readSession('another-client', authStore(saved))).toBeNull();
  await cache.saveLane('client', 'oauth');
  expect(await cache.readSession('client', authStore(saved))).toBeNull();
});
