import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const mockRead = jest.fn();
let mockState = {
  user: { id: 'first' } as { id: string } | null,
  isAuthenticated: true,
  activeSessionId: 'session-one',
  oxyServices: { billing: { productSubscriptions: mockRead, personalPlans: jest.fn() } },
};
jest.mock('../../src/ui/context/OxyContext', () => ({ useOxy: () => mockState }));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_svc: unknown, _session: unknown, run: () => unknown) => run(),
}));
import { usePersonalPlanSubscriptions } from '../../src/ui/hooks/queries/usePersonalPlans';
it('keeps late account-one results out of account-two and disables signed-out reads', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let resolveFirst!: (value: unknown[]) => void;
  mockRead.mockImplementation((id: string) =>
    id === 'first'
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve([{ sourceId: 'second-source' }]),
  );
  const { result, rerender, unmount } = renderHook(usePersonalPlanSubscriptions, { wrapper });
  await waitFor(() => expect(mockRead).toHaveBeenCalledWith('first'));
  mockState = { ...mockState, user: { id: 'second' }, activeSessionId: 'session-two' };
  rerender();
  await waitFor(() => expect(result.current.data).toEqual([{ sourceId: 'second-source' }]));
  resolveFirst([{ sourceId: 'first-source' }]);
  await waitFor(() => expect(result.current.data).toEqual([{ sourceId: 'second-source' }]));
  mockState = { ...mockState, user: null, isAuthenticated: false };
  rerender();
  expect(result.current.data).toBeUndefined();
  expect(mockRead).toHaveBeenCalledTimes(2);
  unmount();
  client.clear();
});
