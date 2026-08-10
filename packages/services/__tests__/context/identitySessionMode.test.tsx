/**
 * @jest-environment-options {"url": "https://commons.oxy.so/"}
 *
 * `sessionMode: 'identity'` — identity-bound sessions (issue #691, Phase 1).
 *
 * An identity-bound provider authenticates as the owner of THIS device's primary
 * identity key, permanently. Every Oxy app on the device shares one
 * `DeviceSession` whose `activeAccountId` any of them can switch; an
 * identity-bound client must track that shared state truthfully while never
 * letting it move its own user or bearer. This suite proves the four behaviours
 * that make that true, plus that account mode is untouched:
 *
 *  1. A remote `session_state` switch to another account leaves the identity-mode
 *     user, session id and planted token exactly where they were.
 *  2. A cold boot mints for the PINNED account — the mint carries the pinned
 *     `accountId` and the restored session is the pinned one, even though the
 *     device's `activeAccountId` is somebody else.
 *  3. A device state that no longer carries the pinned account re-establishes the
 *     identity session from the local key instead of adopting the active account.
 *  4. Every account-graph surface is disabled at the source: `switchToAccount` /
 *     `switchSession` reject, the graph is never fetched, and the dialog is gone.
 *  5. Account mode (the default) still follows the device's active account.
 *
 * `createSessionClient` is mocked so device state is fully controllable and the
 * boot stays offline; the pin store, `resolveIdentityPin`, the projection helpers
 * and the cold-boot lanes are the REAL implementations.
 */

import React from 'react';
import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AUTH_STATE_STORAGE_KEY,
  IDENTITY_PIN_STORAGE_KEY,
  KeyManager,
  SignatureService,
  type User,
} from '@oxyhq/core';
import type { DeviceSessionState } from '@oxyhq/contracts';

const redirectToAuthorize = jest.fn();
jest.mock('../../src/ui/components/oauthNavigation', () => ({
  redirectToAuthorize: (...args: unknown[]) => redirectToAuthorize(...args),
}));

type StateListener = () => void;

/** Device state the fake `SessionClient` reports; mutated per test. */
let deviceState: DeviceSessionState | null = null;
const stateListeners = new Set<StateListener>();
/** The `getPinnedAccountId` resolver `OxyContext` handed to `createSessionClient`. */
let capturedPinResolver: (() => string | null) | undefined;

const fakeSessionClientHost = {
  setCurrentAccountId: jest.fn(),
  setDeviceCredential: jest.fn(),
  getDeviceCredential: () => null,
};
const fakeSessionClient = {
  getState: () => deviceState,
  // The dialog controller reads the directory on every snapshot build, so a
  // stand-in that omits these is not a SessionClient. Null is the honest
  // answer for a fake that was never given one.
  getDirectory: () => null,
  refreshDirectory: async () => null,
  activateContext: async () => null,
  subscribe: (listener: StateListener) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  start: jest.fn(async () => undefined),
  bootstrap: jest.fn(async () => undefined),
  addCurrentAccount: jest.fn(async () => undefined),
  registerAndActivate: jest.fn(async () => undefined),
  switchAccount: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
};

jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createSessionClient: jest.fn(
      (_oxy: unknown, _onUnauthenticated: unknown, getPinnedAccountId?: () => string | null) => {
        capturedPinResolver = getPinnedAccountId;
        return { client: fakeSessionClient, host: fakeSessionClientHost };
      },
    ),
  };
});

import { OxyRuntimeProvider, useOxy } from '../../src/ui/context/OxyContext';
import type { OxyContextState } from '../../src/ui/context/OxyContext';
import { IdentityBoundSessionError } from '../../src/ui/session';
import { useAuthStore } from '../../src/ui/stores/authStore';

const API_BASE_URL = 'https://api.oxy.so';
const PINNED_ACCOUNT = 'acct_pinned';
const OTHER_ACCOUNT = 'acct_other';
/** A storable secp256k1 public key: compressed hex, 66 chars. */
const LOCAL_PUBLIC_KEY = `02${'a'.repeat(64)}`;

/** A decodable (unsigned) JWT so `computeIdentityTag` can read its account. */
function fakeJwt(userId: string): string {
  const encode = (payload: object): string =>
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId })}.sig`;
}

const PINNED_TOKEN = fakeJwt(PINNED_ACCOUNT);
const MINTED_PINNED_TOKEN = fakeJwt(`${PINNED_ACCOUNT}_minted`);

function buildDeviceState(overrides: Partial<DeviceSessionState> = {}): DeviceSessionState {
  return {
    deviceId: 'dev_identity',
    accounts: [
      { accountId: PINNED_ACCOUNT, sessionId: 'sess_pinned', authuser: 0 },
      { accountId: OTHER_ACCOUNT, sessionId: 'sess_other', authuser: 1 },
    ],
    activeAccountId: PINNED_ACCOUNT,
    revision: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function seedIdentityPin(accountId = PINNED_ACCOUNT, publicKey = LOCAL_PUBLIC_KEY): void {
  window.localStorage.setItem(IDENTITY_PIN_STORAGE_KEY, JSON.stringify({ publicKey, accountId }));
}

function seedPersistedSession(overrides: Record<string, unknown> = {}): void {
  window.localStorage.setItem(
    AUTH_STATE_STORAGE_KEY,
    JSON.stringify({
      sessionId: 'sess_pinned',
      userId: PINNED_ACCOUNT,
      deviceId: 'dev_identity',
      deviceSecret: 'identity.device.secret',
      accessToken: PINNED_TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    }),
  );
}

/**
 * An `@oxyhq/core`-shaped stub covering every surface the identity lanes touch:
 * the zero-cookie mint (cold boot), the challenge/verify pair (identity sign-in),
 * and the profile reads the projection makes.
 */
function buildStub(overrides: Record<string, unknown> = {}) {
  let currentToken: string | null = null;
  return {
    config: {},
    httpService: {
      setTokens: (token: string) => {
        currentToken = token;
      },
      setAuthRefreshHandler: jest.fn(),
      refreshAccessToken: jest.fn(async () => null),
      runSingleFlightDeviceSecretMint: (mint: () => Promise<unknown>) => mint(),
    },
    getBaseURL: () => API_BASE_URL,
    getSessionBaseUrl: () => API_BASE_URL,
    getAccessToken: () => currentToken,
    getAccessTokenExpiry: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: (token: string) => {
      currentToken = token;
    },
    clearTokens: () => {
      currentToken = null;
    },
    clearCache: jest.fn(),
    mintFromDeviceSecret: jest.fn(async () => ({
      accessToken: MINTED_PINNED_TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nextDeviceSecret: 'identity.next.secret',
      // The device is switched to somebody else — the pinned account is still a
      // member, and a pinned mint must resolve THAT entry.
      state: buildDeviceState({ activeAccountId: OTHER_ACCOUNT }),
    })),
    requestChallenge: jest.fn(async () => ({ challenge: 'chal_1' })),
    verifyChallenge: jest.fn(async () => ({
      sessionId: 'sess_pinned_reestablished',
      accessToken: fakeJwt(PINNED_ACCOUNT),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceId: 'dev_identity',
      deviceSecret: 'identity.reestablished.secret',
      user: { id: PINNED_ACCOUNT, username: 'pinned' },
    })),
    signInWithSharedIdentity: jest.fn(async () => null),
    getCurrentUser: jest.fn(
      async (): Promise<User> => ({ id: PINNED_ACCOUNT, username: 'pinned' } as User),
    ),
    getUsersByIds: jest.fn(
      async (ids: string[]): Promise<User[]> =>
        ids.map((id) => ({ id, username: `user_${id}` } as User)),
    ),
    listAccounts: jest.fn(async () => []),
    switchToAccount: jest.fn(async () => null),
    ...overrides,
  };
}

let capturedContext: OxyContextState | null = null;

function Capture(): null {
  capturedContext = useOxy();
  return null;
}

function requireContext(): OxyContextState {
  if (!capturedContext) {
    throw new Error('OxyContext was not captured');
  }
  return capturedContext;
}

function renderProvider(oxyServices: unknown, sessionMode?: 'account' | 'identity'): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OxyRuntimeProvider
        oxyServices={oxyServices as never}
        baseURL={API_BASE_URL}
        clientId="oxy_test_client"
        sessionMode={sessionMode}
      >
        <Capture />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
}

/** Push a new device state and fire the `SessionClient` subscribers, as the socket would. */
async function pushDeviceState(next: DeviceSessionState): Promise<void> {
  await act(async () => {
    deviceState = next;
    for (const listener of stateListeners) {
      listener();
    }
    // Let the projection's awaits (pin resolve + profile fetch) settle.
    await Promise.resolve();
  });
}

describe('OxyProvider sessionMode: "identity" (identity-bound sessions)', () => {
  let getPublicKeySpy: jest.SpyInstance;
  let signChallengeSpy: jest.SpyInstance;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    capturedContext = null;
    capturedPinResolver = undefined;
    deviceState = null;
    stateListeners.clear();
    redirectToAuthorize.mockClear();
    useAuthStore.getState().logout();
    for (const value of Object.values(fakeSessionClient)) {
      if (jest.isMockFunction(value)) {
        value.mockClear();
      }
    }
    fakeSessionClientHost.setCurrentAccountId.mockClear();
    fakeSessionClientHost.setDeviceCredential.mockClear();
    getPublicKeySpy = jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(LOCAL_PUBLIC_KEY);
    signChallengeSpy = jest.spyOn(SignatureService, 'signChallenge').mockResolvedValue({
      challenge: 'signature_hex',
      publicKey: LOCAL_PUBLIC_KEY,
      timestamp: 1_700_000_000,
    });
  });

  afterEach(() => {
    getPublicKeySpy.mockRestore();
    signChallengeSpy.mockRestore();
  });

  it('ignores a remote account switch: the pinned user, session and bearer never move', async () => {
    seedIdentityPin();
    seedPersistedSession();
    deviceState = buildDeviceState();
    const stub = buildStub();

    renderProvider(stub, 'identity');
    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    await waitFor(() => expect(requireContext().sessions.length).toBe(2));
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
    const tokenBeforeSwitch = stub.getAccessToken();
    fakeSessionClientHost.setCurrentAccountId.mockClear();

    // Another app on this device switches the shared DeviceSession.
    await pushDeviceState(buildDeviceState({ activeAccountId: OTHER_ACCOUNT, revision: 2 }));
    // The projection DID run against the switched state — and still bound to the
    // pin, so the host's current account never moved.
    await waitFor(() =>
      expect(fakeSessionClientHost.setCurrentAccountId).toHaveBeenCalledWith(PINNED_ACCOUNT),
    );

    // The switch is visible in device state but changes NOTHING here.
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
    expect(requireContext().activeSessionId).toBe('sess_pinned');
    expect(stub.getAccessToken()).toBe(tokenBeforeSwitch);
    expect(fakeSessionClientHost.setCurrentAccountId).not.toHaveBeenCalledWith(OTHER_ACCOUNT);
    // …and the resolver `SessionClient` reads (to bypass its transport + refuse a
    // foreign `activeToken`) reports the pinned account.
    expect(capturedPinResolver?.()).toBe(PINNED_ACCOUNT);
  });

  it('cold boot restores the PINNED account: the mint carries it and the device active account is ignored', async () => {
    seedIdentityPin();
    // Warm token already expired, so the boot falls to the device-secret mint.
    seedPersistedSession({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    // The device was switched away while this app was closed.
    deviceState = buildDeviceState({ activeAccountId: OTHER_ACCOUNT });
    const stub = buildStub();

    renderProvider(stub, 'identity');
    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));

    // The mint was PINNED: it names the account explicitly instead of letting the
    // server mint for whatever `activeAccountId` currently is.
    expect(stub.mintFromDeviceSecret).toHaveBeenCalledWith('dev_identity', 'identity.device.secret', {
      accountId: PINNED_ACCOUNT,
    });
    expect(stub.getAccessToken()).toBe(MINTED_PINNED_TOKEN);
    // The persisted session converged on the pinned account's entry, not the active one.
    const persisted = JSON.parse(window.localStorage.getItem(AUTH_STATE_STORAGE_KEY) ?? '{}');
    expect(persisted.userId).toBe(PINNED_ACCOUNT);
    expect(persisted.sessionId).toBe('sess_pinned');

    await waitFor(() => expect(requireContext().sessions.length).toBe(2));
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
    expect(requireContext().activeSessionId).toBe('sess_pinned');
    // Identity mode never runs the web OAuth restore lane (it would commit
    // whichever account the IdP resolves).
    expect(redirectToAuthorize).not.toHaveBeenCalled();
  });

  it('re-establishes from the local identity key when the pinned account leaves the device', async () => {
    seedIdentityPin();
    seedPersistedSession();
    deviceState = buildDeviceState();
    const stub = buildStub();

    renderProvider(stub, 'identity');
    await waitFor(() => expect(requireContext().user?.id).toBe(PINNED_ACCOUNT));
    stub.requestChallenge.mockClear();
    stub.verifyChallenge.mockClear();
    fakeSessionClient.bootstrap.mockClear();

    // Another app signed the pinned account out of the shared device session.
    await pushDeviceState(
      buildDeviceState({
        accounts: [{ accountId: OTHER_ACCOUNT, sessionId: 'sess_other', authuser: 1 }],
        activeAccountId: OTHER_ACCOUNT,
        revision: 2,
      }),
    );
    await waitFor(() => expect(stub.verifyChallenge).toHaveBeenCalledTimes(1));

    // The local key re-derived the session instead of the projection adopting the
    // only account left on the device.
    expect(stub.requestChallenge).toHaveBeenCalledWith(LOCAL_PUBLIC_KEY, undefined);
    expect(fakeSessionClient.bootstrap).toHaveBeenCalled();
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
    expect(requireContext().activeSessionId).toBe('sess_pinned');
  });

  it('attempts the re-establishment at most once per device revision', async () => {
    seedIdentityPin();
    seedPersistedSession();
    deviceState = buildDeviceState();
    const stub = buildStub({
      // A device the local key can no longer sign into: every attempt fails, so a
      // repeated notify must not turn into a sign-in loop.
      verifyChallenge: jest.fn(async () => null),
    });

    renderProvider(stub, 'identity');
    await waitFor(() => expect(requireContext().user?.id).toBe(PINNED_ACCOUNT));
    stub.requestChallenge.mockClear();

    const orphanedState = buildDeviceState({
      accounts: [{ accountId: OTHER_ACCOUNT, sessionId: 'sess_other', authuser: 1 }],
      activeAccountId: OTHER_ACCOUNT,
      revision: 2,
    });
    await pushDeviceState(orphanedState);
    await waitFor(() => expect(stub.requestChallenge).toHaveBeenCalledTimes(1));
    await pushDeviceState(orphanedState);
    await pushDeviceState(orphanedState);

    expect(stub.requestChallenge).toHaveBeenCalledTimes(1);
    // Still never adopts the account that IS on the device.
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
  });

  it('disables every account-graph surface at the source', async () => {
    seedIdentityPin();
    seedPersistedSession();
    deviceState = buildDeviceState();
    const stub = buildStub();

    renderProvider(stub, 'identity');
    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    await waitFor(() => expect(requireContext().sessions.length).toBe(2));

    expect(requireContext().sessionMode).toBe('identity');
    await expect(requireContext().switchToAccount(OTHER_ACCOUNT)).rejects.toBeInstanceOf(
      IdentityBoundSessionError,
    );
    await expect(requireContext().switchSession('sess_other')).rejects.toBeInstanceOf(
      IdentityBoundSessionError,
    );
    expect(fakeSessionClient.switchAccount).not.toHaveBeenCalled();
    expect(stub.switchToAccount).not.toHaveBeenCalled();

    // The graph is never fetched and the dialog never exists.
    expect(requireContext().accounts).toEqual([]);
    expect(stub.listAccounts).not.toHaveBeenCalled();
    expect(requireContext().accountDialogController).toBeNull();
    act(() => {
      requireContext().openAccountDialog();
    });
    expect(requireContext().isAccountDialogOpen).toBe(false);
  });

  it('account mode (the default) still follows the device active account', async () => {
    seedPersistedSession();
    deviceState = buildDeviceState();
    const stub = buildStub();

    renderProvider(stub);
    await waitFor(() => expect(capturedContext?.isAuthenticated).toBe(true));
    await waitFor(() => expect(requireContext().sessions.length).toBe(2));
    expect(requireContext().user?.id).toBe(PINNED_ACCOUNT);
    expect(requireContext().sessionMode).toBe('account');
    // Nothing is pinned, so `SessionClient` and the transport behave exactly as
    // they do with the option absent.
    expect(capturedPinResolver?.()).toBeNull();

    await pushDeviceState(buildDeviceState({ activeAccountId: OTHER_ACCOUNT, revision: 2 }));

    expect(requireContext().user?.id).toBe(OTHER_ACCOUNT);
    expect(requireContext().activeSessionId).toBe('sess_other');
    expect(fakeSessionClientHost.setCurrentAccountId).toHaveBeenLastCalledWith(OTHER_ACCOUNT);
    // The account graph + dialog stay live.
    expect(requireContext().accountDialogController).not.toBeNull();
    await waitFor(() => expect(stub.listAccounts).toHaveBeenCalled());
    // No identity pin was ever written or read: the local key is untouched.
    expect(window.localStorage.getItem(IDENTITY_PIN_STORAGE_KEY)).toBeNull();
    expect(getPublicKeySpy).not.toHaveBeenCalled();
  });
});
