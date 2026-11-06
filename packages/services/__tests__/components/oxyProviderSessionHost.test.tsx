/**
 * `OxyProvider` picks its session source once, at mount (ADR 0058 decision 1):
 * a registered session host and `sessionMode: 'account'` → the hosted runtime;
 * anything else → the app's own. `'identity'` is never hosted, and a host wins
 * over an `authStateStore`.
 */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryAuthStateStore } from '@oxy.so/core/session';
import { registerOxySessionHost, type OxySessionHost } from '@oxy.so/core/host';

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

const mockOwn = jest.fn();
const mockHosted = jest.fn();
jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  OxyRuntimeProvider: (props: { children?: ReactNode }) => {
    mockOwn(props);
    return props.children;
  },
  useOxy: () => ({ currentLanguage: 'en-US' }),
  useOptionalOxy: () => ({ currentLanguage: 'en-US' }),
}));
jest.mock('../../src/ui/context/OxyHostedContext', () => ({
  __esModule: true,
  OxyHostedRuntimeProvider: (props: { children?: ReactNode }) => {
    mockHosted(props);
    return props.children;
  },
}));
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ currentLanguage: 'en-US' }),
  useOptionalOxy: () => ({ currentLanguage: 'en-US' }),
}));
jest.mock('../../src/ui/hooks/queryClient', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  return {
    __esModule: true,
    createQueryClient: () => new QueryClient(),
    attachQueryPersistence: () => ({ restored: Promise.resolve(), unsubscribe: () => {} }),
  };
});

import OxyProvider from '../../src/ui/components/OxyProvider';

const KEY = Symbol.for('oxy.so/session-host');

const host: OxySessionHost = {
  contract: 1,
  platform: 'oxyos',
  snapshot: () => ({ status: 'signed_out', revision: 0, account: null, online: true }),
  subscribe: () => () => undefined,
  getAccessToken: async () => null,
  request: async () => undefined,
};

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[KEY];
  mockOwn.mockClear();
  mockHosted.mockClear();
});

describe('OxyProvider session source', () => {
  it('runs its own session without a host', () => {
    render(<OxyProvider baseURL="https://api.oxy.test">{null}</OxyProvider>);
    expect(mockOwn).toHaveBeenCalled();
    expect(mockHosted).not.toHaveBeenCalled();
  });

  it('is hosted when a host is registered, and the host wins over an authStateStore', () => {
    registerOxySessionHost(host);
    render(
      <OxyProvider baseURL="https://api.oxy.test" authStateStore={createMemoryAuthStateStore()}>
        {null}
      </OxyProvider>,
    );
    expect(mockOwn).not.toHaveBeenCalled();
    expect(mockHosted).toHaveBeenCalledWith(expect.objectContaining({ session: { host } }));
    expect(mockHosted.mock.calls[0][0]).not.toHaveProperty('authStateStore');
  });

  it('runs signed out (hosted) for a host it cannot speak to', () => {
    Object.defineProperty(globalThis, KEY, { value: { contract: 2 }, configurable: true });
    render(<OxyProvider baseURL="https://api.oxy.test">{null}</OxyProvider>);
    expect(mockOwn).not.toHaveBeenCalled();
    expect(mockHosted).toHaveBeenCalledWith(
      expect.objectContaining({ session: { unknownContract: true } }),
    );
  });

  it('never hosts an identity-bound provider', () => {
    registerOxySessionHost(host);
    render(
      <OxyProvider baseURL="https://api.oxy.test" sessionMode="identity">
        {null}
      </OxyProvider>,
    );
    expect(mockHosted).not.toHaveBeenCalled();
    expect(mockOwn).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: 'identity' }));
  });

  it('passes an authStateStore to its own session', () => {
    const store = createMemoryAuthStateStore();
    render(
      <OxyProvider baseURL="https://api.oxy.test" authStateStore={store}>
        {null}
      </OxyProvider>,
    );
    expect(mockOwn).toHaveBeenCalledWith(expect.objectContaining({ authStateStore: store }));
  });
});
