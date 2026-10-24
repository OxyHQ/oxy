import { runAccountDeletion } from '@/lib/account/delete-account-flow';

/**
 * Identity-safety contract for the account-deletion sequence (MED-1).
 *
 * The dangerous failure mode is over-retention: after the server deletes the
 * account, the local private key + backup must be purged so `useIdentity`
 * cannot auto-restore a "zombie" identity for an account that no longer
 * exists. Equally important, the purge must NEVER run if the server delete
 * fails — otherwise a transient API error would destroy the keys for an
 * account that still exists.
 *
 * `runAccountDeletion` takes its side effects as injected collaborators, so we
 * can assert the exact ordering without a native screen or secure store.
 */
describe('runAccountDeletion', () => {
  const CONFIRM = 'alice';

  function makeDeps() {
    return {
      retirePushToken: jest.fn<Promise<unknown>, []>(async () => ({ status: 'retired' })),
      deleteAccount: jest.fn<Promise<unknown>, [string]>(async () => ({ message: 'ok' })),
      purgeIdentity: jest.fn<Promise<void>, []>(async () => undefined),
      signOutAll: jest.fn<Promise<void>, []>(async () => undefined),
    };
  }

  it('purges the local identity (primary + backup) after a successful server delete', async () => {
    const deps = makeDeps();

    const result = await runAccountDeletion(CONFIRM, deps);

    expect(deps.deleteAccount).toHaveBeenCalledTimes(1);
    expect(deps.deleteAccount).toHaveBeenCalledWith(CONFIRM);
    expect(deps.purgeIdentity).toHaveBeenCalledTimes(1);
    expect(result.localIdentityPurged).toBe(true);
  });

  it('retires the push token first, then purges the local identity BEFORE signing out', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.retirePushToken.mockImplementation(async () => {
      order.push('retirePushToken');
      return { status: 'retired' };
    });
    deps.deleteAccount.mockImplementation(async () => {
      order.push('deleteAccount');
      return { message: 'ok' };
    });
    deps.purgeIdentity.mockImplementation(async () => {
      order.push('purgeIdentity');
    });
    deps.signOutAll.mockImplementation(async () => {
      order.push('signOutAll');
    });

    await runAccountDeletion(CONFIRM, deps);

    // The push registry scopes a retirement to the identity holding the bearer,
    // so it MUST happen before the account is deleted and the session dropped —
    // otherwise this device keeps a live registration for an identity it no
    // longer holds and gets woken by that identity's sign-in requests.
    expect(order).toEqual(['retirePushToken', 'deleteAccount', 'purgeIdentity', 'signOutAll']);
  });

  it('still deletes the account when retiring the push token fails', async () => {
    const deps = makeDeps();
    deps.retirePushToken.mockRejectedValue(new Error('push registry unreachable'));

    const result = await runAccountDeletion(CONFIRM, deps);

    expect(deps.deleteAccount).toHaveBeenCalledTimes(1);
    expect(deps.purgeIdentity).toHaveBeenCalledTimes(1);
    expect(deps.signOutAll).toHaveBeenCalledTimes(1);
    expect(result.localIdentityPurged).toBe(true);
  });

  it('does NOT purge the local identity when the server delete fails', async () => {
    const deps = makeDeps();
    const failure = new Error('account deletion failed');
    deps.deleteAccount.mockRejectedValue(failure);

    await expect(runAccountDeletion(CONFIRM, deps)).rejects.toThrow('account deletion failed');

    // The account still exists server-side — the keys MUST be left intact and
    // the user must NOT be signed out.
    expect(deps.purgeIdentity).not.toHaveBeenCalled();
    expect(deps.signOutAll).not.toHaveBeenCalled();
  });

  it('retires the push token exactly once', async () => {
    const deps = makeDeps();

    await runAccountDeletion(CONFIRM, deps);

    expect(deps.retirePushToken).toHaveBeenCalledTimes(1);
  });

  it('still signs out and reports a non-fatal warning when the local purge fails after a successful delete', async () => {
    const deps = makeDeps();
    deps.purgeIdentity.mockRejectedValue(new Error('secure store locked'));

    const result = await runAccountDeletion(CONFIRM, deps);

    // The account is gone server-side, so we proceed to sign-out regardless and
    // signal the failed purge so the caller can warn the user.
    expect(deps.deleteAccount).toHaveBeenCalledTimes(1);
    expect(deps.signOutAll).toHaveBeenCalledTimes(1);
    expect(result.localIdentityPurged).toBe(false);
  });

  it('signs out exactly once after a clean delete + purge', async () => {
    const deps = makeDeps();

    await runAccountDeletion(CONFIRM, deps);

    expect(deps.signOutAll).toHaveBeenCalledTimes(1);
  });

  // Offline right after the delete: the sign-out used to reject out of the
  // flow, so the screen never reset onboarding or left the deleted account.
  it('resolves when the sign-out fails after a successful delete and purge', async () => {
    const deps = makeDeps();
    deps.signOutAll.mockRejectedValue(new Error('Network request failed'));

    await expect(runAccountDeletion(CONFIRM, deps)).resolves.toEqual({
      localIdentityPurged: true,
    });
    expect(deps.purgeIdentity).toHaveBeenCalledTimes(1);
  });
});
