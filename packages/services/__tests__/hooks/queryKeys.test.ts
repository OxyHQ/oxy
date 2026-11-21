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

describe('queryKeys.sessions', () => {
  it('sessions.device() is unique per deviceId', () => {
    expect(queryKeys.sessions.device('d1')).toEqual(['sessions', 'device', 'd1']);
    expect(queryKeys.sessions.device('d2')).toEqual(['sessions', 'device', 'd2']);
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

  it('invalidateSessionQueries scopes to the sessions root', () => {
    const queryClient = { invalidateQueries: jest.fn() };
    invalidateSessionQueries(queryClient);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sessions'],
    });
  });
});
