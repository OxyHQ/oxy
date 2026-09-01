/**
 * `useAuthStore` is a PROJECTION of the runtime, not a store of its own — so
 * these cases run it the way production does: bound to a runtime, with the
 * writes going through and the reads coming back off the snapshot.
 *
 * With nothing bound, reads answer signed-out and writes are dropped. That is
 * the shape the SSR shim and a provider-less unit test see, and it is asserted
 * here rather than left to be discovered.
 */

import { bindAuthStoreToRuntime, useAuthStore } from '../../src/ui/stores/authStore';
import { createTestRuntime } from '../helpers/runtimeHarness';

describe('authStore projected onto the runtime', () => {
  let unbind: (() => void) | null = null;

  afterEach(() => {
    unbind?.();
    unbind = null;
  });

  it('stores a stable id when the API user only carries _id', () => {
    unbind = bindAuthStoreToRuntime(createTestRuntime());

    useAuthStore.getState().loginSuccess({
      _id: 'user_1',
      username: 'nate',
      publicKey: 'pub_1',
    });

    // Identity normalisation moved into the runtime with the account itself,
    // so `_id` and `id` can never produce two accounts for one person.
    expect(useAuthStore.getState().user?.id).toBe('user_1');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('reflects the runtime rather than holding its own copy', () => {
    const runtime = createTestRuntime();
    unbind = bindAuthStoreToRuntime(runtime);

    runtime.setAccount({ id: 'user_2', username: 'alice', publicKey: 'pub_2' } as never);

    expect(useAuthStore.getState().user?.id).toBe('user_2');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    runtime.clearSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('answers signed out and drops writes when nothing is bound', () => {
    useAuthStore.getState().loginSuccess({ id: 'user_3', username: 'bob', publicKey: 'pub_3' } as never);

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
