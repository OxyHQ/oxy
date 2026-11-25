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

it('offers the cached session while an old sign-out intent is still recorded', async () => {
  // A device signed back in through another app keeps the intent this app
  // recorded at an earlier sign-out; the mint still resumes this holder, so the
  // paint must not wait for it. The sign-out itself deleted the cached profile.
  const cache = createCachedBootStore(createMemoryStorage(), 'oxy_session');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const saved = {
    sessionId: 's1',
    userId: 'u1',
    deviceId: 'd1',
    deviceSecret: 'secret',
    accessToken: 'token',
    expiresAt,
  };
  const store: AuthStateStore = {
    ...authStore(saved),
    isAutomaticIdentitySignInSuppressed: async () => true,
  };
  await cache.saveLane('client', 'device');
  await cache.saveAccount({ id: 'u1', username: 'me' } as User);

  expect(await cache.readSession('client', store)).toMatchObject({
    sessionId: 's1',
    user: { id: 'u1' },
    warmToken: 'token',
  });

  await cache.clearAccount();
  expect(await cache.readSession('client', store)).toBeNull();
});
