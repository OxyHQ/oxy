import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  useCurrentUser: () => ({ data: mockUser }),
}));
jest.mock('../../src/ui/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser, setUser: mockSetUser }) },
}));
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}
beforeEach(() => {
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
  mockUser = { id: 'b', userPreferences: { displayCurrency: 'FAIR' } };
  mockSession = 'b-session';
  rerender();
  await act(async () => finish({ id: 'a', userPreferences: { displayCurrency: 'USD' } }));
  expect(mockSetUser).not.toHaveBeenCalled();
  expect(result.current.currency).toBe('FAIR');
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
