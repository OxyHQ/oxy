/**
 * OxyRuntimeProvider ↔ exported `oxyClient` singleton token-sync integration test.
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * @oxyhq/core exports a module-level `oxyClient` singleton. Apps commonly build
 * their imperative api clients against it (reading `oxyClient.getAccessToken()`
 * to construct `Authorization` headers) while passing ONLY `baseURL` to
 * OxyProvider. In that configuration the runtime constructs its OWN OxyServices
 * instance and plants the session token on THAT instance — so the singleton
 * never received it and imperative consumers sent `Authorization: Bearer null`,
 * which backends reject. (Homiio + Allo both hit this.)
 *
 * OxyRuntimeProvider now subscribes to its instance's `onTokensChanged` and mirrors
 * every token mutation onto the exported `oxyClient` singleton — on sign-in,
 * restore, refresh, AND sign-out/clear — so any imperative consumer reading the
 * singleton always observes the live token (or null when logged out).
 *
 * This test renders the REAL OxyRuntimeProvider against the REAL @oxyhq/core and
 * asserts the singleton tracks the provider instance's token. Only the
 * network/socket seams that fire at mount (web SSO, session socket) are stubbed
 * so the test is deterministic offline; the token-mirroring wiring under test
 * is exercised end-to-end.
 *
 * `createSessionClient` is ALSO mocked (Fase 3-B): once cold boot resolves a
 * token — whether via its own ladder or (as several cases here do) a manual
 * `providerInstance.setTokens(...)` call that races cold boot's in-flight
 * post-ladder check — `OxyContext` hands off to `SessionClient.addCurrentAccount`
 * + `.start()`. Against the REAL `OxyServices` instance built here (no backend
 * behind `https://api.oxy.so` in this unit test), that handoff would otherwise
 * attempt a real, several-second-bounded network round-trip, which has nothing
 * to do with the token-mirroring behavior under test here. Stubbing it to
 * resolve instantly keeps this suite's own concern (token sync) isolated from
 * the SessionClient wiring (covered separately by the ColdBoot-family suites).
 */

import { render, waitFor, act, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { oxyClient, type User } from '@oxyhq/core';

// Neutralize the mount-time network effects so the provider settles
// deterministically without a backend. Forcing the cold boot onto the native
// ladder keeps it offline; this does not touch the token-sync path under test.
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

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

const SIGNED_OUT_TOKEN_VALUE = oxyClient.getAccessToken();

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
      {/* Only baseURL is passed — the reproduction case. The provider builds
          its own instance distinct from the exported singleton. */}
      <OxyRuntimeProvider baseURL="https://api.oxy.so">
        <Capture sink={sink} />
      </OxyRuntimeProvider>
    </QueryClientProvider>,
  );
};

describe('OxyRuntimeProvider mirrors the session token onto the exported oxyClient singleton', () => {
  afterEach(() => {
    // Leave the shared singleton in its original (signed-out) state for any
    // sibling suite that imports it.
    oxyClient.clearTokens();
    useAuthStore.getState().logout();
  });

  it('starts signed out with no token on the singleton', () => {
    expect(SIGNED_OUT_TOKEN_VALUE).toBeNull();
  });

  it('plants the token on the singleton when the provider instance receives one (baseURL-only app)', async () => {
    const sink = makeCapture();
    renderProvider(sink);

    await waitFor(() => expect(sink.current).not.toBeNull());

    const providerInstance = requireContext(sink).oxyServices;
    // Sanity: the provider really did build its OWN instance, NOT the singleton.
    // (If they were the same object the bug couldn't occur and the test would
    // be vacuous.)
    expect(providerInstance).not.toBe(oxyClient);

    // Simulate what real auth flows do: they plant tokens on the provider's
    // instance through `setTokens`.
    act(() => {
      providerInstance.setTokens('access-from-signin');
    });

    await waitFor(() => {
      expect(oxyClient.getAccessToken()).toBe('access-from-signin');
    });
    expect(oxyClient.hasValidToken()).toBe(true);
  });

  it('updates the singleton when the instance token changes (e.g. silent refresh / session switch)', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;

    act(() => {
      providerInstance.setTokens('access-1');
    });
    await waitFor(() => expect(oxyClient.getAccessToken()).toBe('access-1'));

    act(() => {
      providerInstance.setTokens('access-2-refreshed');
    });
    await waitFor(() => expect(oxyClient.getAccessToken()).toBe('access-2-refreshed'));
  });

  it('clears the singleton token on sign-out (clearTokens on the instance)', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;

    act(() => {
      providerInstance.setTokens('access-before-logout');
    });
    await waitFor(() => expect(oxyClient.getAccessToken()).toBe('access-before-logout'));

    // Sign-out path: clearSessionState() now clears the instance's tokens,
    // which fires onTokensChanged(null) and mirrors the clear to the singleton.
    act(() => {
      providerInstance.clearTokens();
    });

    await waitFor(() => {
      expect(oxyClient.getAccessToken()).toBeNull();
    });
    expect(oxyClient.hasValidToken()).toBe(false);
  });

  it('stops mirroring after the provider unmounts (subscription cleanup)', async () => {
    const sink = makeCapture();
    const { unmount } = renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;

    act(() => {
      providerInstance.setTokens('access-live');
    });
    await waitFor(() => expect(oxyClient.getAccessToken()).toBe('access-live'));

    unmount();

    // After unmount the mirror is torn down: further instance mutations must
    // NOT leak onto the singleton.
    act(() => {
      providerInstance.setTokens('access-after-unmount');
    });

    // Give any (incorrectly-surviving) async listener a tick to fire.
    await act(async () => {
      await Promise.resolve();
    });

    expect(oxyClient.getAccessToken()).toBe('access-live');
  });

  it('clears provider auth state when the provider instance token is invalidated', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;
    const authenticatedUser = { id: 'user_invalidated', username: 'stale-user' } as User;

    act(() => {
      providerInstance.setTokens('access-before-invalidated');
      useAuthStore.getState().loginSuccess(authenticatedUser);
    });

    await waitFor(() => {
      expect(requireContext(sink).isAuthenticated).toBe(true);
    });
    expect(requireContext(sink).hasAccessToken).toBe(true);
    expect(requireContext(sink).canUsePrivateApi).toBe(true);
    expect(requireContext(sink).isPrivateApiPending).toBe(false);

    act(() => {
      providerInstance.clearTokens();
    });

    await waitFor(() => {
      expect(requireContext(sink).isAuthenticated).toBe(false);
    });
    expect(requireContext(sink).user).toBeNull();
    expect(requireContext(sink).hasAccessToken).toBe(false);
    expect(requireContext(sink).canUsePrivateApi).toBe(false);
    expect(requireContext(sink).isTokenReady).toBe(true);
  });

  it('clears provider auth state when listing accounts returns 401', async () => {
    const sink = makeCapture();
    renderProvider(sink);
    await waitFor(() => expect(sink.current).not.toBeNull());
    const providerInstance = requireContext(sink).oxyServices;
    const unauthorizedError = Object.assign(new Error('Unauthorized'), { status: 401 });
    const listAccountsSpy = jest
      .spyOn(providerInstance, 'listAccounts')
      .mockRejectedValue(unauthorizedError);
    const authenticatedUser = { id: 'user_managed_401', username: 'stale-user' } as User;

    act(() => {
      providerInstance.setTokens('access-before-managed-401');
      useAuthStore.getState().loginSuccess(authenticatedUser);
    });

    // On auth-ready both the context's `refreshAccounts` AND the account-dialog
    // controller's own graph refresh call `listAccounts` (two independent
    // consumers of the same source); the 401 clears provider auth either way.
    await waitFor(() => {
      expect(listAccountsSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(requireContext(sink).isAuthenticated).toBe(false);
    });
    expect(requireContext(sink).accounts).toEqual([]);
    expect(providerInstance.getAccessToken()).toBeNull();
  });
});
