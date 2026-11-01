import assert from 'node:assert/strict';
import { createMemoryAuthStateStore } from '../../packages/core/src/session/authStateStore';
import {
  createSharedMirroringAuthStateStore,
  type SharedDeviceCredential,
  type SharedDeviceCredentialStore,
} from '../../packages/core/src/session/sharedDeviceCredential';

const current = { deviceId: 'device', deviceSecret: 'candidate' };
const old = { deviceId: 'device', deviceSecret: 'old' };
let first = current;
let second = old;
let writes = 0;
const shared: SharedDeviceCredentialStore = {
  read: async () => ({ state: 'present', credential: first }),
  publish: async (value: SharedDeviceCredential) => {
    writes++;
    first = value;
    second = value;
    return true;
  },
  clear: async () => {},
};
const state = { sessionId: 'session', userId: 'user', ...current };
const store = createSharedMirroringAuthStateStore({ local: createMemoryAuthStateStore(), shared });
assert.equal(await store.save(state), true);
assert.equal(await store.save({ ...state, accessToken: 'new-token' }), true);
const restarted = createSharedMirroringAuthStateStore({ local: createMemoryAuthStateStore(), shared });
assert.equal(await restarted.save(state), true);
assert.equal(writes, 0);
assert.deepEqual(second, old);
console.log('real core wrapper: matching first host skips replica repair, including after restart');
