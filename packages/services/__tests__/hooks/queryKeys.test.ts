/**
 * Tests for the centralized query keys.
 *
 * These keys are stable contract — every consumer of `useQueryClient()`
 * relies on the exact array shape returned here to invalidate / set
 * data. Re-ordering elements or changing the leaf token would silently
 * break offline persistence (the persisted cache keys would no longer
 * match the new in-memory keys).
 */

import {
  invalidateAccountQueries,
  invalidateSessionQueries,
  invalidateUserQueries,
  queryKeys,
} from '../../src/ui/hooks/queries/queryKeys';

describe('queryKeys.accounts', () => {
  it("uses ['accounts'] as root", () => {
    expect(queryKeys.accounts.all).toEqual(['accounts']);
  });

  it('list() includes the sessionIds in the leaf', () => {
    const ids = ['s1', 's2'];
    expect(queryKeys.accounts.list(ids)).toEqual(['accounts', 'list', ids]);
  });

  it('detail() builds [accounts, detail, sessionId]', () => {
    expect(queryKeys.accounts.detail('s1')).toEqual(['accounts', 'detail', 's1']);
  });

  it('current() is a stable singleton prefix and scopes by sessionId when supplied', () => {
    expect(queryKeys.accounts.current()).toEqual(['accounts', 'current']);
    expect(queryKeys.accounts.current('s1')).toEqual(['accounts', 'current', 's1']);
  });
});

describe('queryKeys.users', () => {
  it('profile() is keyed by sessionId, not userId', () => {
    expect(queryKeys.users.profile('s1')).toEqual(['users', 'detail', 's1', 'profile']);
  });

  it('detail() is keyed by userId', () => {
    expect(queryKeys.users.detail('u1')).toEqual(['users', 'detail', 'u1']);
  });

  it('detailForViewer() scopes relationship-bearing fetches by viewer', () => {
    expect(queryKeys.users.detailForViewer('u1', '')).toEqual([
      'users',
      'detail',
      'u1',
      'viewer',
      '',
    ]);
    expect(queryKeys.users.detailForViewer('u1', 'viewer-2')).toEqual([
      'users',
      'detail',
      'u1',
      'viewer',
      'viewer-2',
    ]);
  });

  it('byUsername() scopes relationship-bearing fetches by viewer', () => {
    expect(queryKeys.users.byUsername('alice', '')).toEqual([
      'users',
      'detail',
      'username',
      'alice',
      'viewer',
      '',
    ]);
    expect(queryKeys.users.byUsername('alice', 'viewer-2')).toEqual([
      'users',
      'detail',
      'username',
      'alice',
      'viewer',
      'viewer-2',
    ]);
  });

  it('byUsername() normalizes username casing/whitespace so seeders agree by construction', () => {
    const canonical = queryKeys.users.byUsername('alice', 'viewer-2');
    expect(queryKeys.users.byUsername('Alice', 'viewer-2')).toEqual(canonical);
    expect(queryKeys.users.byUsername('ALICE', 'viewer-2')).toEqual(canonical);
    expect(queryKeys.users.byUsername('  Alice  ', 'viewer-2')).toEqual(canonical);
  });

  it('list() includes the supplied userIds', () => {
    expect(queryKeys.users.list(['a', 'b'])).toEqual(['users', 'list', ['a', 'b']]);
  });
});

describe('queryKeys.sessions / devices / privacy / security', () => {
  it('sessions.device() is unique per deviceId', () => {
    expect(queryKeys.sessions.device('d1')).toEqual(['sessions', 'device', 'd1']);
    expect(queryKeys.sessions.device('d2')).toEqual(['sessions', 'device', 'd2']);
  });

  it("privacy.settings() resolves to 'current' when no userId is provided", () => {
    expect(queryKeys.privacy.settings()).toEqual(['privacy', 'settings', 'current']);
    expect(queryKeys.privacy.settings('u1')).toEqual(['privacy', 'settings', 'u1']);
  });

  it('security.activity() includes every filter argument in the key', () => {
    expect(queryKeys.security.activity(25, 50, 'login')).toEqual([
      'security',
      'activity',
      25,
      50,
      'login',
    ]);
  });

  it('security.infinite() includes the eventType only when supplied', () => {
    expect(queryKeys.security.infinite(25)).toEqual(['security', 'infinite', 25, undefined]);
    expect(queryKeys.security.infinite(25, 'logout')).toEqual([
      'security',
      'infinite',
      25,
      'logout',
    ]);
  });
});

describe('queryKeys.payments', () => {
  it("uses ['payments'] as root", () => {
    expect(queryKeys.payments.all).toEqual(['payments']);
  });

  it("subscription() resolves to 'current' when no userId is provided", () => {
    expect(queryKeys.payments.subscription()).toEqual(['payments', 'subscription', 'current']);
    expect(queryKeys.payments.subscription('u1')).toEqual(['payments', 'subscription', 'u1']);
  });

  it('history() builds [payments, history, current]', () => {
    expect(queryKeys.payments.history()).toEqual(['payments', 'history', 'current']);
  });

  it('wallet() builds [payments, wallet, current]', () => {
    expect(queryKeys.payments.wallet()).toEqual(['payments', 'wallet', 'current']);
  });

  it('walletTransactions() includes pagination in the leaf so pages cache independently', () => {
    expect(queryKeys.payments.walletTransactions(5, 0)).toEqual([
      'payments',
      'wallet',
      'current',
      'transactions',
      5,
      0,
    ]);
    expect(queryKeys.payments.walletTransactions(5, 5)).toEqual([
      'payments',
      'wallet',
      'current',
      'transactions',
      5,
      5,
    ]);
  });
});

describe('queryKeys.storage', () => {
  it("uses ['storage'] as root", () => {
    expect(queryKeys.storage.all).toEqual(['storage']);
  });

  it('usage() builds [storage, usage]', () => {
    expect(queryKeys.storage.usage()).toEqual(['storage', 'usage']);
  });
});

describe('invalidate helpers', () => {
  it('invalidateAccountQueries scopes invalidation to the accounts root', () => {
    const queryClient = { invalidateQueries: jest.fn() };
    invalidateAccountQueries(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['accounts'],
    });
  });

  it('invalidateUserQueries scopes to the users root', () => {
    const queryClient = { invalidateQueries: jest.fn() };
    invalidateUserQueries(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['users'],
    });
  });

  it('invalidateSessionQueries scopes to the sessions root', () => {
    const queryClient = { invalidateQueries: jest.fn() };
    invalidateSessionQueries(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sessions'],
    });
  });
});
