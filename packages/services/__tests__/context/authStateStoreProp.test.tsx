/**
 * @jest-environment-options {"url": "https://app.oxy.so/"}
 *
 * `authStateStore` — a platform's setup client's seam (OxyOS's login screen):
 * the provider persists the session credential through the store it is given
 * and nowhere else. No platform store is built, the device-wide shared slot is
 * never consulted (no adopt, no publish) and no background credential is made.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Platform } from 'react-native';
import type { AuthStateStore, PersistedAuthState } from '@oxy.so/core/session';
import type { User } from '@oxy.so/core';

let mockWebBrowser = false;
jest.mock('../../src/ui/utils/isWebBrowser', () => ({ isWebBrowser: () => mockWebBrowser }));

const mockCreateSharedStore = jest.fn(() => null);
jest.mock('../../src/ui/session/sharedDeviceCredentialStore', () => ({
  ...jest.requireActual('../../src/ui/session/sharedDeviceCredentialStore'),
  createPlatformSharedDeviceCredentialStore: () => mockCreateSharedStore(),
}));
const mockBackgroundSync = jest.fn();
const fakeSessionClientHost = {
  setCurrentAccountId: jest.fn(),
  setDeviceCredential: jest.fn(),
  getDeviceCredential: () => null,
};
const fakeSessionClient = {
  getState: jest.fn(() => null),
  resetLocalState: jest.fn(),
  getDirectory: jest.fn(() => null),
  refreshDirectory: jest.fn(async () => undefined),
  activateContext: jest.fn(async () => undefined),
  signOutContext: jest.fn(async () => undefined),
  signOutPrincipal: jest.fn(async () => undefined),
  subscribe: jest.fn(() => () => undefined),
  start: jest.fn(async () => undefined),
  bootstrap: jest.fn(async () => undefined),
  adoptState: jest.fn(() => true),
  addCurrentAccount: jest.fn(async () => undefined),
  registerAndActivate: jest.fn(async () => undefined),
  switchAccount: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
};
const mockCreatePlatformAuthStateStore = jest.fn();
jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createPlatformAuthStateStore: (...args: unknown[]) => mockCreatePlatformAuthStateStore(...args),
    createSessionClient: jest.fn(() => ({
      client: fakeSessionClient,
      host: fakeSessionClientHost,
    })),
    useBackgroundSessionSync: (options: unknown) => mockBackgroundSync(options),
  };
});

import { OxyRuntimeProvider, useOxy, type OxyContextState } from '../../src/ui/context/OxyContext';

const API = 'https://api.oxy.so';
const USER_ID = 'user_setup_1';
const SECRET = 'setup.device.secret.value';

function stubServices() {
  let currentToken: string | null = null;
  return {
    config: {},
    http: {
      setTokens: (value: string) => {
        currentToken = value;
      },
      setAuthRefreshHandler: jest.fn(),
      refreshAccessToken: jest.fn(async () => null),
      runSingleFlightDeviceSecretMint: (mint: () => Promise<unknown>) => mint(),
      getSessionEpoch: () => 0,
    },
    baseURL: API,
    getSessionBaseUrl: () => API,
    session: {
      get accessToken() {
        return currentToken;
      },
      get accessTokenExpiry() {
        return null;
      },
      get userId() {
        return null;
      },
      onChange: () => () => undefined,
      setDeviceCredentialProvider: () => () => undefined,
      setAccessToken: (value: string) => {
        currentToken = value;
      },
      clear: () => {
        currentToken = null;
      },
    },
    cache: { clear: jest.fn() },
    apps: {
      getPublic: jest.fn(async () => ({
        id: 'oxyos-login',
        name: 'OxyOS',
        type: 'first_party',
        isOfficial: true,
        isInternal: false,
        scopes: [],
      })),
    },
    devices: { mintToken: jest.fn(async () => null) },
    auth: { signInWithCommonsIdentity: jest.fn(async () => null) },
    users: {
      me: jest.fn(async (): Promise<User> => ({ id: USER_ID, username: 'setup' }) as User),
      getMany: jest.fn(async () => []),
    },
    accounts: { list: jest.fn(async () => []) },
  };
}

function handingOverStore() {
  let held: PersistedAuthState | null = null;
  const store: AuthStateStore & { save: jest.Mock; clear: jest.Mock } = {
    load: jest.fn(async () => held),
    save: jest.fn(async (state: PersistedAuthState) => {
      held = state;
      return true;
    }),
    clear: jest.fn(async () => {
      held = null;
    }),
  };
  return store;
}

let captured: OxyContextState | null = null;
function Capture() {
  captured = useOxy();
  return null;
}

const originalOS = Platform.OS;

beforeEach(() => {
  captured = null;
  window.localStorage.clear();
  mockCreateSharedStore.mockClear();
  mockCreatePlatformAuthStateStore.mockClear();
  mockBackgroundSync.mockClear();
});
afterEach(() => {
  Platform.OS = originalOS;
  mockWebBrowser = false;
});

describe.each([
  ['a native setup client', 'android' as const, false],
  ['a web setup client', 'web' as const, true],
])('OxyProvider authStateStore (%s)', (_name, os, web) => {
  it('hands the committed credential to the store and writes it nowhere else', async () => {
    Platform.OS = os;
    mockWebBrowser = web;
    const store = handingOverStore();
    const services = stubServices();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OxyRuntimeProvider
          oxyServices={services as never}
          baseURL={API}
          clientId="oxyos_client"
          authStateStore={store}
          backgroundSession
        >
          <Capture />
        </OxyRuntimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(captured?.isAuthResolved).toBe(true));
    expect(captured?.isAuthenticated).toBe(false);

    // What the email-code, password and authenticator panels (and the sign-up)
    // commit through: `handleWebSession` with the session the sign-in returned.
    await act(async () => {
      await captured?.handleWebSession({
        sessionId: 'sess_setup',
        accessToken: 'setup.access.token',
        deviceId: 'dev_setup',
        deviceSecret: SECRET,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        user: { id: USER_ID, username: 'setup' },
      } as never);
    });

    await waitFor(() => expect(captured?.isAuthenticated).toBe(true));
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'dev_setup', deviceSecret: SECRET, userId: USER_ID }),
    );
    expect(mockCreatePlatformAuthStateStore).not.toHaveBeenCalled();
    expect(mockCreateSharedStore).not.toHaveBeenCalled();
    for (const call of mockBackgroundSync.mock.calls) {
      expect((call[0] as { enabled: boolean }).enabled).toBe(false);
    }
    const persisted = Object.keys(window.localStorage).map((key) =>
      window.localStorage.getItem(key),
    );
    expect(persisted.some((value) => value?.includes(SECRET))).toBe(false);
  });
});
