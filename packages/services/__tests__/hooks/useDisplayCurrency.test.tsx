import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { User } from '../../src/ui/data/user';
import { useDisplayCurrency } from '../../src/ui/hooks/useDisplayCurrency';

let mockUser = { id: 'a', userPreferences: { displayCurrency: 'EUR' } };
let mockSession = 'a-session';
let mockAuthenticated = true;
const mockUpdate = jest.fn();
const mockSetUser = jest.fn();
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_client: unknown, _session: unknown, fn: () => unknown) => fn(),
}));
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    oxyServices: { users: { updateMe: mockUpdate } },
    user: mockUser,
    activeSessionId: mockSession,
    isAuthenticated: mockAuthenticated,
  }),
}));
jest.mock('../../src/ui/hooks/queries/useAccountQueries', () => ({
  useCurrentUser: () => ({ value: mockUser }),
}));
jest.mock('../../src/ui/runtime/activeRuntime', () => ({
  activeRuntime: () => ({
    getSnapshot: () => ({ account: mockUser }),
    setAccount: mockSetUser,
  }),
}));

/** Each account's store, as the session opens one per account. */
const stores = new Map<string, Store>();
function storeOf(account: string): Store {
  let store = stores.get(account);
  if (!store) {
    store = new Store();
    stores.set(account, store);
  }
  return store;
}
function wrapper({ children }: { children: ReactNode }) {
  return <DataProvider store={storeOf(mockUser.id)}>{children}</DataProvider>;
}
beforeEach(() => {
  stores.clear();
  mockUser = { id: 'a', userPreferences: { displayCurrency: 'EUR' } };
  mockSession = 'a-session';
  mockAuthenticated = true;
  mockUpdate.mockReset();
  mockSetUser.mockReset();
});
test('restores account preference and replaces it on account switch', () => {
  const { result, rerender } = renderHook(useDisplayCurrency, { wrapper });
  expect(result.current.currency).toBe('EUR');
  mockUser = { id: 'b', userPreferences: { displayCurrency: 'FAIR' } };
  mockSession = 'b-session';
  rerender();
  expect(result.current.currency).toBe('FAIR');
});
test('a saved choice joins the account and the signed-in profile', async () => {
  const saved = { id: 'a', userPreferences: { displayCurrency: 'USD' } };
  mockUpdate.mockResolvedValue(saved);
  const { result } = renderHook(useDisplayCurrency, { wrapper });
  act(() => result.current.selectCurrency('USD'));
  await waitFor(() => expect(mockSetUser).toHaveBeenCalledWith(saved));
  expect(withStore(storeOf('a'), () => User.get('a'))?.userPreferences).toEqual({
    displayCurrency: 'USD',
  });
  expect(result.current.isSaving).toBe(false);
});
test('a response after account switching never overwrites the current account', async () => {
  let finish: (value: unknown) => void = () => {};
  mockUpdate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(useDisplayCurrency, { wrapper });
  act(() => result.current.selectCurrency('USD'));
  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith({ userPreferences: { displayCurrency: 'USD' } }),
  );
  // The session opens B's store and closes A's.
  await act(async () => {
    await storeOf('a').close();
  });
  mockUser = { id: 'b', userPreferences: { displayCurrency: 'FAIR' } };
  mockSession = 'b-session';
  rerender();
  await act(async () => finish({ id: 'a', userPreferences: { displayCurrency: 'USD' } }));
  expect(mockSetUser).not.toHaveBeenCalled();
  expect(withStore(storeOf('b'), () => User.get('a'))).toBeUndefined();
  expect(result.current.currency).toBe('FAIR');
});
test('refuses an answer for another account than the one that chose', async () => {
  mockUpdate.mockResolvedValue({ id: 'someone-else', userPreferences: { displayCurrency: 'USD' } });
  const { result } = renderHook(useDisplayCurrency, { wrapper });
  act(() => result.current.selectCurrency('USD'));
  await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  expect(mockSetUser).not.toHaveBeenCalled();
});
test('signed out selection makes no private write', () => {
  mockAuthenticated = false;
  const { result } = renderHook(useDisplayCurrency, { wrapper });
  act(() => result.current.selectCurrency('EUR'));
  expect(result.current.currency).toBe('EUR');
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('signed out selector and price observers share one display preference', () => {
  mockAuthenticated = false;
  const first = renderHook(useDisplayCurrency, { wrapper });
  const second = renderHook(useDisplayCurrency, { wrapper });
  act(() => first.result.current.selectCurrency('FAIR'));
  expect(second.result.current.currency).toBe('FAIR');
});
