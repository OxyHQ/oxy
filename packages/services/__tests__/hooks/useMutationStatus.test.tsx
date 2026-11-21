/**
 * Tests for `useMutationStatus`.
 *
 * The aggregator powers the app shell's "Syncing…" indicator. It must
 * distinguish running writes from writes waiting for the network, because
 * those map to different UI affordances. A bug here can either mark a fully
 * synced state as syncing or hide a real offline backlog.
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { action, DataProvider, environment, Store, withStore } from '@oxy.so/bloom-data';
import { useMutationStatus } from '../../src/ui/hooks/useMutationStatus';

let release: () => void = () => undefined;
const write = action({
  run: () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }),
});

describe('useMutationStatus', () => {
  let store: Store;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataProvider store={store}>{children}</DataProvider>
  );

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    environment.setOnline(true);
  });

  it('reports zeroes when nothing is being written', () => {
    const { result } = renderHook(() => useMutationStatus(), { wrapper });
    expect(result.current).toEqual({
      pending: 0,
      paused: 0,
      total: 0,
      isOffline: false,
      isSyncing: false,
    });
  });

  it('counts a write while it runs, and nothing once it settles', async () => {
    const { result } = renderHook(() => useMutationStatus(), { wrapper });
    let call!: Promise<unknown>;
    act(() => {
      call = withStore(store, () => write());
    });
    await waitFor(() => expect(result.current.pending).toBe(1));
    expect(result.current).toMatchObject({ total: 1, isSyncing: true, isOffline: false });

    await act(async () => {
      release();
      await call;
    });
    expect(result.current.total).toBe(0);
  });

  it('counts a write waiting for the network as paused', async () => {
    environment.setOnline(false);
    const { result } = renderHook(() => useMutationStatus(), { wrapper });
    let call!: Promise<unknown>;
    act(() => {
      call = withStore(store, () => write());
    });
    await waitFor(() => expect(result.current.paused).toBe(1));
    expect(result.current).toMatchObject({ pending: 0, isOffline: true, isSyncing: true });

    act(() => environment.setOnline(true));
    await waitFor(() => expect(result.current.pending).toBe(1));
    await act(async () => {
      release();
      await call;
    });
    expect(result.current.total).toBe(0);
  });
});
