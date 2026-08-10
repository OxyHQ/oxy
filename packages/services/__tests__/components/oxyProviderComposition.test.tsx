/**
 * `OxyProvider` — the ONE public composition root (ADR 0004).
 *
 * These cases pin the two composition invariants a future edit is most likely
 * to break silently, because neither produces an error when it regresses:
 *
 *  - **One QueryClient.** A consumer-supplied client must become *the* client
 *    for the whole subtree. If the provider ever created its own alongside it,
 *    the SDK's account hooks and the app's own hooks would read two different
 *    caches — an invalidation on one would simply not reach the other, and the
 *    UI would just show stale data.
 *  - **Outlets mount exactly once.** Bloom's `ToastOutlet` and `SurfaceHost`
 *    both render from a MODULE-LEVEL store, so a second mount of either renders
 *    every toast and every surface twice, in two stacked copies.
 *
 * The session runtime is stubbed out: this is a test of the composition root's
 * wiring, and booting the real state machine would only add network seams that
 * say nothing about it. `__tests__/context/*` cover the runtime itself.
 */
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, useQueryClient } from '@tanstack/react-query';

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => children,
}));

jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => children,
}));

// The runtime provider is exercised by the context suites; here it is a
// pass-through so the composition around it is what the assertions see.
jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  OxyRuntimeProvider: ({ children }: { children?: ReactNode }) => children,
  useOxy: () => ({ currentLanguage: 'en-US' }),
  useOptionalOxy: () => ({ currentLanguage: 'en-US' }),
}));

const createQueryClientMock = jest.fn(() => new QueryClient());
const attachQueryPersistenceMock = jest.fn(() => ({
  restored: Promise.resolve(),
  unsubscribe: () => {},
}));

jest.mock('../../src/ui/hooks/queryClient', () => ({
  __esModule: true,
  createQueryClient: () => createQueryClientMock(),
  attachQueryPersistence: () => attachQueryPersistenceMock(),
}));

import OxyProvider from '../../src/ui/components/OxyProvider';

let observedClient: QueryClient | null = null;

function ClientProbe() {
  observedClient = useQueryClient();
  return <div data-testid="probe" />;
}

beforeEach(() => {
  observedClient = null;
  createQueryClientMock.mockClear();
  attachQueryPersistenceMock.mockClear();
});

describe('OxyProvider — one QueryClient', () => {
  it('uses a supplied QueryClient as THE client and creates none of its own', async () => {
    const supplied = new QueryClient();

    const { findByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so" queryClient={supplied}>
        <ClientProbe />
      </OxyProvider>,
    );

    await findByTestId('probe');

    expect(observedClient).toBe(supplied);
    expect(createQueryClientMock).not.toHaveBeenCalled();
    // Persistence is the host app's lifecycle when it owns the client.
    expect(attachQueryPersistenceMock).not.toHaveBeenCalled();
  });

  it('creates exactly one client when the consumer supplies none', async () => {
    const { findByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so">
        <ClientProbe />
      </OxyProvider>,
    );

    await findByTestId('probe');

    expect(createQueryClientMock).toHaveBeenCalledTimes(1);
    expect(observedClient).not.toBeNull();
  });
});

describe('OxyProvider — outlets mount exactly once', () => {
  it('renders one toast outlet and one surface host', async () => {
    const { findByTestId, queryAllByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so" queryClient={new QueryClient()}>
        <ClientProbe />
      </OxyProvider>,
    );

    await findByTestId('probe');

    expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(1);
    expect(queryAllByTestId('bloom-surface-host')).toHaveLength(1);
  });

  it('mounts no outlets at all while the boot shell is up', async () => {
    // No supplied client + persistence still resolving => the boot shell path.
    // It must not render a second copy of either outlet when the real tree
    // takes over, which is exactly what a copy in the shell would cause.
    let releaseRestore: () => void = () => {};
    attachQueryPersistenceMock.mockImplementationOnce(() => ({
      restored: new Promise<void>((resolve) => {
        releaseRestore = () => resolve();
      }),
      unsubscribe: () => {},
    }));

    const { queryAllByTestId, findByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so">
        <ClientProbe />
      </OxyProvider>,
    );

    expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(0);
    expect(queryAllByTestId('bloom-surface-host')).toHaveLength(0);

    // Storage init is async, so the persistence attach (and with it the
    // `releaseRestore` handle) only exists once the bootstrap effect gets there.
    await waitFor(() => {
      expect(attachQueryPersistenceMock).toHaveBeenCalledTimes(1);
    });
    expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(0);

    releaseRestore();

    await findByTestId('probe');
    await waitFor(() => {
      expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(1);
    });
    expect(queryAllByTestId('bloom-surface-host')).toHaveLength(1);
  });
});
