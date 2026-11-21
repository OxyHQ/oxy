/**
 * The Oxy Trust reads on `@oxy.so/bloom-data`: standing kept by the account's
 * id, and the rules read again only once stale.
 */
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DataProvider, skip, Store, useRecord } from '@oxy.so/bloom-data';
import type { OxyServices } from '@oxy.so/core';
import { reputationRules, TRUST_LEDGER_LIMIT, trustStanding } from '../trust';

const reputation = {
  balance: jest.fn(async () => ({ userId: 'u1', total: 42, trustTier: 'trusted' })),
  transactions: jest.fn(async (_userId: string, _page: unknown) => [{ id: 't1', points: 5 }]),
  rules: jest.fn(async () => [{ actionType: 'post_created', points: 1, category: 'content' }]),
};
const oxy = { reputation } as unknown as OxyServices;

let store: Store;
const wrapper = ({ children }: { children?: ReactNode }) => (
  <DataProvider store={store}>{children}</DataProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  store = new Store();
});

afterEach(() => {
  jest.useRealTimers();
  return store.close();
});

it("reads an account's standing by its id, once while fresh", async () => {
  const first = renderHook(() => useRecord(trustStanding, oxy, 'u1'), { wrapper });
  await waitFor(() => expect(first.result.current.value?.balance.total).toBe(42));
  expect(first.result.current.value?.transactions).toEqual([{ id: 't1', points: 5 }]);
  expect(reputation.transactions).toHaveBeenCalledWith('u1', {
    limit: TRUST_LEDGER_LIMIT,
    offset: 0,
  });
  first.unmount();

  // A profile write hands the screen a new `user` with the same id: nothing is read again.
  const again = renderHook(() => useRecord(trustStanding, oxy, 'u1'), { wrapper });
  expect(again.result.current.value?.balance.total).toBe(42);
  expect(reputation.balance).toHaveBeenCalledTimes(1);
});

it('reads no standing until the account is known', () => {
  const { result } = renderHook(() => useRecord(trustStanding, skip), { wrapper });
  expect(result.current.isLoading).toBe(false);
  expect(reputation.balance).not.toHaveBeenCalled();
});

it('reads the rules again only after ten minutes', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-21T10:00:00.000Z') });
  const first = renderHook(() => useRecord(reputationRules, oxy), { wrapper });
  await waitFor(() => expect(first.result.current.value?.rules).toHaveLength(1));
  first.unmount();

  jest.setSystemTime(new Date('2026-11-21T10:09:00.000Z'));
  renderHook(() => useRecord(reputationRules, oxy), { wrapper }).unmount();
  expect(reputation.rules).toHaveBeenCalledTimes(1);

  jest.setSystemTime(new Date('2026-11-21T10:10:01.000Z'));
  renderHook(() => useRecord(reputationRules, oxy), { wrapper });
  await waitFor(() => expect(reputation.rules).toHaveBeenCalledTimes(2));
});
