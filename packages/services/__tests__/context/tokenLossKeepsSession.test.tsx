/**
 * A cleared bearer with the device credential intact is NOT a sign-out
 * (OxyHQ/Mention#1140).
 *
 * `HttpService` clears the token when a 401's refresh comes back empty — which
 * also happens while the mint is rate limited or the network is down. The
 * provider used to sign the user out on the spot, and since the refresh
 * scheduler stops once there is no token, only a relaunch brought the session
 * back. It now keeps the user, pauses private queries, and re-mints the way the
 * cold boot would; it still signs out when the credential is gone.
 *
 * Real provider, real core, offline session client.
 */

import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxy.so/core';

// Neutralize the mount-time network effects so the provider settles
// deterministically without a backend. Forcing the cold boot onto the native
// ladder keeps it offline; this does not touch the token-sync path under test.
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

// The durable device credential is what separates a transient token loss from a
// revocation. Controlled per test.
let mockHasDeviceCredential = true;
jest.mock('../../src/ui/utils/deviceCredential', () => {
  const actual = jest.requireActual('../../src/ui/utils/deviceCredential');
  return {
    ...actual,
    hasPersistedSessionCredential: jest.fn(async () => mockHasDeviceCredential),
  };
});

jest.mock('../../src/ui/session', () => {
  const actual = jest.requireActual('../../src/ui/session');
  return {
    ...actual,
    createSessionClient: jest.fn(() => ({
      client: {
        getState: () => null,
        // The dialog controller reads the directory on every snapshot build, so a
        // stand-in that omits these is not a SessionClient. Null is the honest
        // answer for a fake that was never given one.
        getDirectory: () => null,
        refreshDirectory: async () => undefined,
        activateContext: async () => undefined,
        signOutContext: async () => undefined,
        signOutPrincipal: async () => undefined,
        subscribe: () => () => undefined,
        addCurrentAccount: jest.fn(async () => undefined),
        start: jest.fn(async () => undefined),
      },
      host: { setCurrentAccountId: jest.fn(), setDeviceCredential: jest.fn(), getDeviceCredential: () => null },
    })),
  };
});

import { OxyRuntimeProvider, useOxy, type OxyContextState } from '../../src/ui/context/OxyContext';
import { useAuthStore } from '../../src/ui/stores/authStore';

/**
 * Captures the live context so the test can drive the provider's OWN
 * OxyServices instance the way the real auth flows do.
 */
function makeCapture(): { current: OxyContextState | null } {
  return { current: null };
}

const Capture: React.FC<{ sink: { current: OxyContextState | null } }> = ({ sink }) => {
  sink.current = useOxy();
  return null;
};

/** Narrow the captured context to non-null after `waitFor` has resolved it. */
function requireContext(sink: { current: OxyContextState | null }): OxyContextState {
  if (!sink.current) {
    throw new Error('OxyContext was not captured');
  }
  return sink.current;
}

const renderProvider = (sink: { current: OxyContextState | null }): RenderResult => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* Only baseURL is passed: the provider builds its own instance. */}
      <OxyRuntimeProvider baseURL="https://api.oxy.so">
        <Capture sink={sink} />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
};

describe('OxyRuntimeProvider after its access token is cleared', () => {
  afterEach(() => {
    useAuthStore.getState().logout();
    mockHasDeviceCredential = true;
    jest.restoreAllMocks();
  });

  it('keeps the user signed in while the device credential survives, and restores the token by re-minting', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;
    const user = { id: 'user_transient', username: 'still-me' } as User;

    act(() => {
      providerInstance.session.setAccessToken('access-before-transient-loss');
      useAuthStore.getState().loginSuccess(user);
    });
    await waitFor(() => expect(requireContext(sink).canUsePrivateApi).toBe(true));

    // The mint is cooling down (rate limited) for the first attempt, then works.
    const refresh = jest
      .spyOn(providerInstance.http, 'refreshAccessToken')
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => {
        providerInstance.session.setAccessToken('access-reminted');
        return 'access-reminted';
      });

    // What HttpService does on a 401 whose refresh came back empty.
    act(() => {
      providerInstance.session.clear();
    });

    // Still signed in, private API paused rather than failing.
    expect(requireContext(sink).isAuthenticated).toBe(true);
    await waitFor(() => expect(requireContext(sink).isPrivateApiPending).toBe(true));
    expect(requireContext(sink).canUsePrivateApi).toBe(false);

    await waitFor(() => expect(providerInstance.session.accessToken).toBe('access-reminted'), { timeout: 5_000 });
    await waitFor(() => expect(requireContext(sink).canUsePrivateApi).toBe(true));
    expect(requireContext(sink).isAuthenticated).toBe(true);
    expect(requireContext(sink).user?.id).toBe('user_transient');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('signs out when the device credential is gone (a real revocation)', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;
    const user = { id: 'user_revoked', username: 'revoked' } as User;

    act(() => {
      providerInstance.session.setAccessToken('access-before-revocation');
      useAuthStore.getState().loginSuccess(user);
    });
    await waitFor(() => expect(requireContext(sink).isAuthenticated).toBe(true));

    mockHasDeviceCredential = false;
    act(() => {
      providerInstance.session.clear();
    });

    await waitFor(() => expect(requireContext(sink).isAuthenticated).toBe(false));
    expect(requireContext(sink).user).toBeNull();
  });
});
