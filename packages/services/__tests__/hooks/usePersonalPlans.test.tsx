import { act, renderHook, waitFor } from '@testing-library/react';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
const mockRead = jest.fn();
const mockCatalogue = jest.fn();
let mockState = {
  user: { id: 'first' } as { id: string } | null,
  isAuthenticated: true,
  activeSessionId: 'session-one',
  oxyServices: { billing: { productSubscriptions: mockRead, personalPlans: mockCatalogue } },
};
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({ useOxy: () => mockState }));
jest.mock('@oxy.so/core', () => ({
  authenticatedApiCall: (_svc: unknown, _session: unknown, run: () => unknown) => run(),
}));
import {
  usePersonalPlanSubscriptions,
  usePersonalPlans,
} from '../../src/ui/hooks/queries/usePersonalPlans';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActiveStore(new Store());
  mockRead.mockReset();
  mockCatalogue.mockReset();
  mockState = {
    ...mockState,
    user: { id: 'first' },
    isAuthenticated: true,
    activeSessionId: 'session-one',
  };
});

it('keeps late account-one results out of account-two and skips signed-out reads', async () => {
  let resolveFirst!: (value: unknown[]) => void;
  mockRead.mockImplementation((id: string) =>
    id === 'first'
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve([{ sourceId: 'second-source' }]),
  );
  const { result, rerender, unmount } = renderHook(usePersonalPlanSubscriptions);
  await waitFor(() => expect(mockRead).toHaveBeenCalledWith('first'));
  mockState = { ...mockState, user: { id: 'second' }, activeSessionId: 'session-two' };
  rerender();
  await waitFor(() => expect(result.current.value).toEqual([{ sourceId: 'second-source' }]));
  await act(async () => {
    resolveFirst([{ sourceId: 'first-source' }]);
  });
  expect(result.current.value).toEqual([{ sourceId: 'second-source' }]);
  mockState = { ...mockState, user: null, isAuthenticated: false };
  rerender();
  expect(result.current.value).toBeUndefined();
  expect(mockRead).toHaveBeenCalledTimes(2);
  unmount();
});

it('shows a dropped answer again only once it is read again', async () => {
  mockRead.mockResolvedValue([{ sourceId: 'one' }]);
  const first = renderHook(usePersonalPlanSubscriptions);
  await waitFor(() => expect(first.result.current.value).toHaveLength(1));
  first.unmount();
  // Nothing is kept once no screen shows it (`gcTime: 0`).
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });

  const reply = deferred<unknown[]>();
  mockRead.mockReturnValueOnce(reply.promise);
  const again = renderHook(usePersonalPlanSubscriptions);
  await act(async () => {});
  expect(again.result.current.value).toBeUndefined();
  expect(again.result.current.isLoading).toBe(true);
  await act(async () => {
    reply.resolve([]);
  });
  expect(again.result.current.value).toEqual([]);
});

it('reads the public catalogue again on every mount (never fresh)', async () => {
  mockCatalogue.mockResolvedValue({ plans: [] });
  const first = renderHook(usePersonalPlans);
  await waitFor(() => expect(first.result.current.value).toEqual({ plans: [] }));
  first.unmount();
  const second = renderHook(usePersonalPlans);
  expect(second.result.current.value).toEqual({ plans: [] });
  await waitFor(() => expect(mockCatalogue).toHaveBeenCalledTimes(2));
});
