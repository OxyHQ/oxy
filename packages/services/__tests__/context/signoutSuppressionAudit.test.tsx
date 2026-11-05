/**
 * @jest-environment-options {"url": "https://app.oxy.so/"}
 *
 * Device-first cold boot in `OxyContext` via `runProviderColdBoot`.
 *
 *   1. A signed-out boot resolves to `isAuthResolved: true` / `isAuthenticated:
 *      false` WITHOUT any navigation — the app renders its own "Sign in with
 *      Oxy" affordance instead of being bounced. This is the DEFAULT provider
 *      (no `webAuthMode` prop): phase 7b deleted the cross-origin silent restore
 *      that used to bounce this exact case to `auth.oxy.so?prompt=none`.
 *   2. A returning device (a persisted zero-cookie device credential —
 *      `deviceId` + `deviceSecret`) restores the session on boot: the credential
 *      mints a fresh access token, the account is handed off to the SessionClient
 *      (`addCurrentAccount` — cold boot ensures MEMBERSHIP, not a deliberate
 *      activation), and the full user is hydrated via `getCurrentUser`.
 *
 * `createSessionClient` is mocked so the post-boot handoff is deterministic +
 * offline (the real client opens a socket + hits the backend); its `getState()`
 * returns null so the authenticated projection comes from `commitSession`'s
 * `getCurrentUser`.
 */

import React from 'react';
import { render, waitFor, act, fireEvent, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { AUTH_STATE_STORAGE_KEY, createNativeAuthStateStore } from '@oxy.so/core/session';
import { type User } from '@oxy.so/core';

let mockWebBrowser = true;
let mockActualClient: any;
let mockNativeStore: any;
jest.mock('../../src/ui/utils/isWebBrowser', () => ({ isWebBrowser: () => mockWebBrowser }));
type BootOptions = Parameters<
  typeof import('../../src/ui/boot/runProviderColdBoot').runProviderColdBoot
>[0];
let mockCommitFromBoot: BootOptions['commitSession'] | null = null;
jest.mock('../../src/ui/boot/runProviderColdBoot', () => {
  const actual = jest.requireActual('../../src/ui/boot/runProviderColdBoot');
  return {
    ...actual,
    runProviderColdBoot: (options: BootOptions) => {
      mockCommitFromBoot = options.commitSession;
      return actual.runProviderColdBoot(options);
    },
  };
});
const mockOAuthCompletion = jest.fn();
jest.mock('../../src/ui/oauth/browserAuthTransport', () => {
  const actual = jest.requireActual('../../src/ui/oauth/browserAuthTransport');
  return { ...actual, startWebOAuthSignIn: (...args: unknown[]) => mockOAuthCompletion(...args) };
});
jest.mock('../../src/ui/session/sharedDeviceCredentialStore', () => {
  const actual = jest.requireActual('../../src/ui/session/sharedDeviceCredentialStore');
  return { ...actual, createPlatformSharedDeviceCredentialStore: jest.fn(() => null) };
});
const redirectToAuthorize = jest.fn();
jest.mock('../../src/ui/components/oauthNavigation', () => ({
  redirectToAuthorize: (...args: unknown[]) => redirectToAuthorize(...args),
}));

const fakeSessionClientHost = {
  setCurrentAccountId: jest.fn(),
  setDeviceCredential: jest.fn(),
  getDeviceCredential: () => null,
};
const fakeSessionClient = {
  getState: jest.fn(() => null),
  resetLocalState: jest.fn(),
  // The dialog controller reads the directory on every snapshot build, and the
  // runtime reaches the context lane through the same client, so a stand-in
  // that omits these is not a SessionClient. Null is the honest answer for a
  // fake that was never given a directory.
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
jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createPlatformAuthStateStore: jest.fn((...args: unknown[]) =>
      mockNativeStore ?? actual.createPlatformAuthStateStore(...args),
    ),
    createSessionClient: jest.fn((...args: unknown[]) => {
      const pair = actual.createSessionClient(...args);
      mockActualClient = pair.client;
      pair.client.start = jest.fn(async () => undefined);
      pair.client.registerAndActivate = jest.fn(async () => undefined);
      pair.client.addCurrentAccount = jest.fn(async () => undefined);
      return pair;
    }),
  };
});

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import type { OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';
import { useAuth } from '../../src/ui/hooks/useAuth';
import OxySignInButton from '../../src/ui/components/OxySignInButton';
import { KeyManager } from '@oxy.so/core/crypto';
import { ACCOUNT_QUERY_CACHE_KEY } from '../../src/ui/hooks/accountQueryPersistence';
import { snapshot } from '../../src/ui/hooks/persistedQueryCache';

const API_BASE_URL = 'https://api.oxy.so';
const USER_ID = 'user_cb_1';

/**
 * A `@oxy.so/core`-shaped stub. `mintFromDeviceSecret` is the zero-cookie mint the
 * web cold boot uses to restore a returning device; it is only called when a
 * `deviceId` + `deviceSecret` is persisted, so a signed-out boot (no seed) never
 * reaches it. `getCurrentUser` hydrates the committed session in the restore case.
 */
function buildStub(overrides: Record<string, unknown> = {}) {
  let currentToken: string | null = null;
  return {
    stub: {
      config: {},
      http: {
        setTokens: (token: string) => {
          currentToken = token;
        },
        setAuthRefreshHandler: jest.fn(),
        refreshAccessToken: jest.fn(async () => null),
        // The device-secret mint runs through the client's single-flight; a plain
        // passthrough is enough for these (non-concurrent) integration paths.
        runSingleFlightDeviceSecretMint: (mint: () => Promise<unknown>) => mint(),
        getSessionEpoch: () => 0,
      },
      baseURL: API_BASE_URL,
      getSessionBaseUrl: () => API_BASE_URL,
      session: {
        get accessToken() {
          return (() => currentToken)();
        },
        get accessTokenExpiry() {
          return (() => null)();
        },
        onChange: () => () => undefined,
        setDeviceCredentialProvider: () => () => undefined,
        setAccessToken: (token: string) => {
          currentToken = token;
        },
        clear: () => {
          currentToken = null;
        },
      },
      cache: { clear: jest.fn() },
      apps: {
        getPublic: jest.fn(async () => ({
          id: 'registered-app',
          name: 'Registered App',
          type: 'first_party',
          isOfficial: false,
          isInternal: false,
          scopes: [],
        })),
      },
      devices: {
        mintToken: jest.fn(async () => ({
          accessToken: 'cb.minted.access',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          nextDeviceSecret: 'cb.next.secret',
          state: {
            deviceId: 'dev-cb',
            accounts: [{ accountId: USER_ID, sessionId: 'sess_cb', authuser: 0 }],
            activeAccountId: USER_ID,
            revision: 1,
            updatedAt: Date.now(),
          },
        })),
      },
      auth: { signInWithCommonsIdentity: jest.fn(async () => null) },
      users: {
        me: jest.fn(async (): Promise<User> => ({ id: USER_ID, username: 'cbuser' }) as User),
        getMany: jest.fn(async () => []),
      },
      accounts: { list: jest.fn(async () => []) },
      ...overrides,
    },
  };
}

let capturedContext: OxyContextState | null = null;
let capturedAuth: ReturnType<typeof useAuth> | null = null;

function Capture() {
  capturedContext = useOxy();
  capturedAuth = useAuth();
  return null;
}

function renderProvider(
  oxyServices: unknown,
  options: { button?: boolean; onError?: jest.Mock; children?: React.ReactNode } = {},
): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider
        oxyServices={oxyServices as never}
        baseURL={API_BASE_URL}
        clientId="oxy_test_client"
        onError={options.onError}
      >
        <Capture />
        {options.button && <OxySignInButton text="Retry sign in" />}
        {options.children}
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

it('audits a new device sign-in while an earlier native suppression write is in progress', async () => {
  const values = new Map<string, string>();
  let hold = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (hold && key === 'oxy.auth.automatic-identity-signin-suppressed.v1') {
        entered();
        await barrier;
      }
      values.set(key, value);
    },
    removeItem: async (key: string) => { values.delete(key); },
  };
  mockNativeStore = createNativeAuthStateStore(storage);
  const { stub } = buildStub();
  const state = (deviceId: string, revision: number, account: string | null) => ({
    deviceId, revision, updatedAt: Date.now(), activeAccountId: account,
    accounts: account ? [{ accountId: account, sessionId: `session-${account}`, authuser: 0 }] : [],
  });
  renderProvider(stub);
  await waitFor(() => expect(capturedContext?.isAuthResolved).toBe(true));
  if (!mockCommitFromBoot) throw new Error('commit not captured');
  const commit = mockCommitFromBoot;
  await act(async () => {
    await commit({ sessionId: 'session-user_cb_1', userId: USER_ID, user: { id: USER_ID },
      accessToken: 'a-token', deviceId: 'd1', deviceSecret: 'secret1', deviceState: state('d1', 1, USER_ID),
    } as never, { activate: true });
  });
  hold = true;
  await act(async () => { mockActualClient.applyState(state('d1', 2, null), 'push'); await started; });
  stub.users.me.mockResolvedValue({ id: 'user-b', username: 'b' } as User);
  let next!: Promise<void>;
  await act(async () => {
    next = commit({ sessionId: 'session-user-b', userId: 'user-b', user: { id: 'user-b' },
      accessToken: 'b-token', deviceId: 'd2', deviceSecret: 'secret2', deviceState: state('d2', 1, 'user-b'),
    } as never, { activate: true });
    await Promise.resolve();
  });
  expect(mockActualClient.getState()?.deviceId).toBe('d2');
  hold = false;
  await act(async () => { release(); await next; });
  expect(await mockNativeStore.isAutomaticIdentitySignInSuppressed()).toBe(false);
  expect(await mockNativeStore.load()).toMatchObject({ deviceId: 'd2' });
});
