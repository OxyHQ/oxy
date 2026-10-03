// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProductSubscriptions, useCreditGrants, useCredits, useTransactions, useCancelNamedSubscription } from '../use-billing';
import type { PropsWithChildren } from 'react';
const mock = vi.hoisted(() => ({ subject: 'A', product: vi.fn(), grants: vi.fn(), request: vi.fn(), cancel: vi.fn() }));
vi.mock('@oxy.so/services', () => ({ useAuth: () => ({ user: { id: mock.subject }, isAuthenticated: true, isReady: true,
  oxyServices: { request: mock.request, billing: { productSubscriptions: mock.product, creditGrants: mock.grants, cancelProductSubscriptionWithStatus: mock.cancel } } }) }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
beforeEach(() => { mock.subject = 'A'; vi.clearAllMocks(); });
it('a late A response never appears in the B product/grant/balance/history view', async () => {
  let releaseProduct!: (value: unknown) => void; let releaseGrant!: (value: unknown) => void;
  let releaseCredits!: (value: unknown) => void; let releaseHistory!: (value: unknown) => void;
  mock.product.mockImplementationOnce(() => new Promise(resolve => { releaseProduct = resolve; })).mockResolvedValue([{ sourceId: 'B-source' }]);
  mock.grants.mockImplementationOnce(() => new Promise(resolve => { releaseGrant = resolve; })).mockResolvedValue([{ id: 'B-grant' }]);
  mock.request.mockImplementation((_: string, route: string) => {
    if (mock.subject === 'B') return Promise.resolve(route === '/credits/' ? { credits: 2 } : { transactions: ['B-history'] });
    return new Promise(resolve => { if (route === '/credits/') releaseCredits = resolve; else releaseHistory = resolve; });
  });
  const { wrapper, client } = setup();
  const hook = renderHook(() => ({ products: useProductSubscriptions(), grants: useCreditGrants(), credits: useCredits(), history: useTransactions() }), { wrapper });
  await waitFor(() => expect(mock.product).toHaveBeenCalledTimes(1));
  mock.subject = 'B'; hook.rerender();
  await waitFor(() => expect(hook.result.current.products.data).toEqual([{ sourceId: 'B-source' }]));
  await act(async () => { releaseProduct([{ sourceId: 'A-source' }]); releaseGrant([{ id: 'A-grant' }]); releaseCredits({ credits: 999 }); releaseHistory({ transactions: ['A-history'] }); });
  expect(hook.result.current.products.data).toEqual([{ sourceId: 'B-source' }]);
  expect(hook.result.current.grants.data).toEqual([{ id: 'B-grant' }]);
  expect(hook.result.current.credits.data).toEqual({ credits: 2 });
  expect(hook.result.current.history.data).toEqual({ transactions: ['B-history'] });
  expect(client.getQueryData(['product-subscriptions', 'A'])).toEqual([{ sourceId: 'A-source' }]);
  expect(mock.request).toHaveBeenCalledWith('GET', '/credits/', undefined, { cache: false });
  client.clear();
});
it('rejects an A selection after switching to B and invalidates only the captured subject after a pending cancellation', async () => {
  const { wrapper, client } = setup(); const invalidate = vi.spyOn(client, 'invalidateQueries');
  const hook = renderHook(() => useCancelNamedSubscription(), { wrapper });
  mock.subject = 'B'; hook.rerender();
  await expect(hook.result.current.mutateAsync({ id: 'A-source', kind: 'product', subject: 'A' })).rejects.toThrow('account changed');
  expect(mock.cancel).not.toHaveBeenCalled();
  let release!: () => void; mock.cancel.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  let pending!: Promise<unknown>;
  await act(async () => { pending = hook.result.current.mutateAsync({ id: 'B-source', kind: 'product', subject: 'B' }); });
  await waitFor(() => expect(mock.cancel).toHaveBeenCalledWith('B-source', 'B'));
  mock.subject = 'A'; hook.rerender(); await act(async () => { release(); await pending; });
  expect(invalidate.mock.calls.map(([input]) => input?.queryKey)).toEqual([['product-subscriptions', 'B'], ['credit-subscriptions', 'B'], ['subscription', 'B']]);
  client.clear();
});

it('returns provider-accepted pending reconciliation instead of completed cancellation', async () => {
  const { wrapper, client } = setup();
  mock.cancel.mockResolvedValue({ sourceId: 'A-source', reconciliationPending: true });
  const hook = renderHook(() => useCancelNamedSubscription(), { wrapper });
  let result: unknown;
  await act(async () => { result = await hook.result.current.mutateAsync({ id: 'A-source', kind: 'product', subject: 'A' }); });
  expect(result).toEqual({ sourceId: 'A-source', reconciliationPending: true });
  expect(result).not.toHaveProperty('cancelAtPeriodEnd');
  client.clear();
});
