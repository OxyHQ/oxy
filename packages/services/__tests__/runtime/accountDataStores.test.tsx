/**
 * The session opens each account's `@oxy.so/bloom-data` store (ADR 0002's
 * ordering): the subject change opens the next account's store BEFORE anybody
 * is woken, so a consumer woken by a switch already reads the new account's
 * records, and the previous account's store is closed (a late answer for it is
 * dropped).
 */

import type React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { activeStore, type Persister, type Store, useStore } from '@oxy.so/bloom-data';

jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

import { OxyRuntimeProvider } from '../../src/ui/context/OxyContext';
import { useOxyRuntime } from '../../src/runtime';
import type { OxyRuntime } from '../../src/runtime';
import { User } from '../../src/ui/data/user';

/** A durable copy per account that keeps nothing; it tells a store's account. */
type TaggedPersister = Persister & { account: string };
function persisterFor(account: string): TaggedPersister {
  return {
    account,
    open: async () => undefined,
    readRecords: async () => [],
    readList: async () => null,
    write: async () => undefined,
    close: async () => undefined,
  };
}
const accountOf = (store: Store | undefined) =>
  (store?.persister as TaggedPersister | undefined)?.account;

const Capture: React.FC<{ sink: { runtime?: OxyRuntime; stores: Store[] } }> = ({ sink }) => {
  sink.runtime = useOxyRuntime();
  sink.stores.push(useStore());
  return null;
};

function renderProvider(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider baseURL="https://api.oxy.so" dataPersister={persisterFor}>
        {children}
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("the session opens each account's data store", () => {
  it('opens the signed-out store at mount, then each subject before waking anybody', () => {
    const sink: { runtime?: OxyRuntime; stores: Store[] } = { stores: [] };
    const view = renderProvider(<Capture sink={sink} />);
    const runtime = sink.runtime as OxyRuntime;
    expect(accountOf(sink.stores.at(-1))).toBe('anon');

    const seenOnWake: Array<string | undefined> = [];
    const unsubscribe = runtime.subscribe(() => seenOnWake.push(accountOf(activeStore())));
    act(() => {
      runtime.setAccount({ id: 'ana', username: 'ana' } as never);
    });
    expect(seenOnWake).toEqual(['ana']);
    const anaStore = sink.stores.at(-1) as Store;
    expect(accountOf(anaStore)).toBe('ana');

    act(() => {
      runtime.setAccount({ id: 'bo', username: 'bo' } as never);
    });
    expect(seenOnWake).toEqual(['ana', 'bo']);
    expect(accountOf(sink.stores.at(-1))).toBe('bo');
    expect(anaStore.closed).toBe(true);
    unsubscribe();
    view.unmount();
    expect(sink.stores.at(-1)?.closed).toBe(true);
  });

  it("keeps one account's people out of the next account's store", () => {
    const sink: { runtime?: OxyRuntime; stores: Store[] } = { stores: [] };
    const view = renderProvider(<Capture sink={sink} />);
    const runtime = sink.runtime as OxyRuntime;
    act(() => {
      runtime.setAccount({ id: 'ana', username: 'ana' } as never);
    });
    User.put({ id: 'friend', username: 'friend', relationship: { isFollowing: true } });
    expect(User.get('friend')?.relationship).toEqual({ isFollowing: true });
    act(() => {
      runtime.setAccount({ id: 'bo', username: 'bo' } as never);
    });
    expect(User.has('friend')).toBe(false);
    view.unmount();
  });
});
