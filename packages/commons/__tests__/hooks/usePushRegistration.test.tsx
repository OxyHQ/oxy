import { act, renderHook, waitFor } from '@testing-library/react';
import {
  __EXPO_PUSH_TOKEN as EXPO_TOKEN,
  __resetNotificationAdapter,
  __resetOxyState,
  __setOxyState,
  getExpoPushToken,
  hasNotificationPermission,
  pushTokenPlatform,
  requestNotificationPermission,
} from '@/__mocks__/oxyhq-services';
import { OXY_CLIENT_ID } from '@/constants/oxy';
import { usePushRegistration } from '@/hooks/notifications/usePushRegistration';
import { LocaleProvider } from '@/lib/i18n';

/**
 * The hook localizes the Android channel's user-visible name, so it needs the
 * locale context the app always provides at the root. Rendering it bare would
 * only be testing a provider omission that cannot happen in the real tree.
 */
function renderPushRegistration(): void {
  renderHook(() => usePushRegistration(), { wrapper: LocaleProvider });
}

interface PushMocks {
  registerPushToken: jest.Mock;
  unregisterPushToken: jest.Mock;
}

function installSession(
  overrides: { canUsePrivateApi?: boolean; userId?: string; deviceId?: string } = {},
): PushMocks {
  const services: PushMocks = {
    registerPushToken: jest.fn(async () => undefined),
    unregisterPushToken: jest.fn(async () => undefined),
  };
  __setOxyState({
    isAuthenticated: overrides.canUsePrivateApi ?? false,
    canUsePrivateApi: overrides.canUsePrivateApi ?? false,
    user: { id: overrides.userId ?? 'user-1', username: 'nate' },
    oxyServices: services,
    sessionClient: overrides.deviceId
      ? { getState: () => ({ deviceId: overrides.deviceId ?? '' }) }
      : null,
  });
  return services;
}

/**
 * Registration is what lets a desktop "Continue with Oxy" reach this phone, so
 * the hook's contract is entirely about NOT firing too early: a bearer-authed
 * call before the session resolves is a guaranteed 401, and a registration
 * without the OS permission is one the user never agreed to.
 *
 * The device half is the shared `@oxyhq/services` adapter (stubbed here, tested
 * in that package), so what these tests pin is the Commons orchestration around
 * it: the gate, the client-id scoping, and the one-attempt-per-identity rule.
 */
describe('usePushRegistration', () => {
  beforeEach(() => {
    __resetOxyState();
    __resetNotificationAdapter();
  });

  it('does not register before a session exists', async () => {
    const services = installSession({ canUsePrivateApi: false });

    renderPushRegistration();

    // Give any stray async work a chance to run before asserting the negative.
    await act(async () => {
      await Promise.resolve();
    });
    expect(services.registerPushToken).not.toHaveBeenCalled();
  });

  it('registers once the session resolves, scoped to the Commons client id', async () => {
    const services = installSession({ canUsePrivateApi: false });

    renderPushRegistration();
    expect(services.registerPushToken).not.toHaveBeenCalled();

    act(() => {
      __setOxyState({ isAuthenticated: true, canUsePrivateApi: true });
    });

    await waitFor(() => expect(services.registerPushToken).toHaveBeenCalledTimes(1));
    expect(services.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: EXPO_TOKEN,
      platform: 'android',
      clientId: OXY_CLIENT_ID,
    });
  });

  it("threads the device session's deviceId when one is available", async () => {
    const services = installSession({ canUsePrivateApi: true, deviceId: 'device-9' });

    renderPushRegistration();

    await waitFor(() => expect(services.registerPushToken).toHaveBeenCalledTimes(1));
    expect(services.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-9' }),
    );
  });

  it('does not register while the OS permission is not granted', async () => {
    hasNotificationPermission.mockResolvedValue(false);
    const services = installSession({ canUsePrivateApi: true });

    renderPushRegistration();

    await act(async () => {
      await Promise.resolve();
    });
    expect(services.registerPushToken).not.toHaveBeenCalled();
  });

  it('never prompts for the permission — onboarding owns the single dialog', async () => {
    const services = installSession({ canUsePrivateApi: true });

    renderPushRegistration();

    await waitFor(() => expect(services.registerPushToken).toHaveBeenCalledTimes(1));
    expect(hasNotificationPermission).toHaveBeenCalled();
    // The prompting entry point is not part of this path, on any cold boot.
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('registers nothing on a platform Oxy does not deliver push to', async () => {
    // The shared adapter reports `null` for anything that is not iOS/Android —
    // web included, since browser push is not wired. Nothing is even asked about
    // permission in that case.
    pushTokenPlatform.mockReturnValue(null);
    const services = installSession({ canUsePrivateApi: true });

    renderPushRegistration();

    await act(async () => {
      await Promise.resolve();
    });
    expect(services.registerPushToken).not.toHaveBeenCalled();
    expect(hasNotificationPermission).not.toHaveBeenCalled();
    expect(getExpoPushToken).not.toHaveBeenCalled();
  });

  it('registers nothing when no Expo push token can be minted', async () => {
    // The live shape of this today: the build carries no EAS project id, so the
    // adapter warns and resolves null rather than minting an unusable token.
    getExpoPushToken.mockResolvedValue(null);
    const services = installSession({ canUsePrivateApi: true });

    renderPushRegistration();

    await act(async () => {
      await Promise.resolve();
    });
    expect(services.registerPushToken).not.toHaveBeenCalled();
  });

  it('registers at most once per identity, across re-renders', async () => {
    const services = installSession({ canUsePrivateApi: true });

    const { rerender } = renderHook(() => usePushRegistration(), { wrapper: LocaleProvider });
    await waitFor(() => expect(services.registerPushToken).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(services.registerPushToken).toHaveBeenCalledTimes(1);
  });

  it('swallows a registration failure — push is a convenience, not a gate', async () => {
    const services = installSession({ canUsePrivateApi: true });
    services.registerPushToken.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => usePushRegistration(), { wrapper: LocaleProvider });

    await waitFor(() => expect(services.registerPushToken).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });
});
