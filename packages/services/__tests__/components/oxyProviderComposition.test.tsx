/**
 * `OxyProvider` — the ONE public composition root (ADR 0004).
 *
 * These cases pin the composition invariants a future edit is most likely to
 * break silently, because none produces an error when it regresses:
 *
 *  - **Outlets mount exactly once.** Bloom's `ToastOutlet` and `SurfaceHost`
 *    both render from a MODULE-LEVEL store, so a second mount of either renders
 *    every toast and every surface twice, in two stacked copies.
 *  - **Nothing gates the first render.** The device storage initialises in the
 *    background; the application tree exists before it is ready.
 *  - **Account screens load lazily**, when a surface first opens.
 *
 * The session runtime is stubbed out: this is a test of the composition root's
 * wiring, and booting the real state machine would only add network seams that
 * say nothing about it. `__tests__/context/*` cover the runtime itself.
 */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => children,
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    SafeAreaProvider: ({ children }: { children?: ReactNode }) => children,
    SafeAreaInsetsContext: createContext(null),
    SafeAreaFrameContext: createContext(null),
  };
});

// The runtime provider is exercised by the context suites; here it is a
// pass-through so the composition around it is what the assertions see.
jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  OxyRuntimeProvider: ({ children }: { children?: ReactNode }) => children,
  useOxy: () => ({ currentLanguage: 'en-US' }),
  useOptionalOxy: () => ({ currentLanguage: 'en-US' }),
}));

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ currentLanguage: 'en-US' }),
  useOptionalOxy: () => ({ currentLanguage: 'en-US' }),
}));

let releaseStorage: () => void = () => {};
jest.mock('../../src/ui/utils/storageHelpers', () => {
  const actual = jest.requireActual('../../src/ui/utils/storageHelpers');
  return {
    ...actual,
    createPlatformStorage: () =>
      new Promise((resolve) => {
        releaseStorage = () => resolve(actual.createMemoryStorage());
      }),
  };
});

import OxyProvider from '../../src/ui/components/OxyProvider';
import * as screenRoutes from '../../src/ui/navigation/routes';

function Probe() {
  return <div data-testid="probe" />;
}

describe('OxyProvider — composition', () => {
  it('does not load account screens before a surface is opened', async () => {
    const loadScreens = jest.spyOn(screenRoutes, 'loadScreens').mockResolvedValue();
    const { findByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so">
        <Probe />
      </OxyProvider>,
    );
    await findByTestId('probe');
    expect(loadScreens).not.toHaveBeenCalled();
    loadScreens.mockRestore();
  });

  it('renders one toast outlet and one surface host', async () => {
    const { findByTestId, queryAllByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so">
        <Probe />
      </OxyProvider>,
    );

    await findByTestId('probe');

    expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(1);
    expect(queryAllByTestId('bloom-surface-host')).toHaveLength(1);
  });

  it('renders the application tree before the device storage is ready', async () => {
    const { findByTestId, queryAllByTestId } = render(
      <OxyProvider baseURL="https://api.oxy.so">
        <Probe />
      </OxyProvider>,
    );

    await findByTestId('probe');
    expect(queryAllByTestId('bloom-toast-outlet')).toHaveLength(1);

    releaseStorage();
    await findByTestId('probe');
    expect(queryAllByTestId('bloom-surface-host')).toHaveLength(1);
  });
});
