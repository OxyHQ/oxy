/**
 * The hook's contract: the ONLY path to the push registry is the SDK
 * (`oxyServices.registerPushToken` / `unregisterPushToken` from `@oxyhq/core`),
 * it fires only once a bearer exists and the user has asked to be notified, and
 * turning the preference off retires the exact token that was registered.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { configureLogger, resetLoggerConfig } from '@oxyhq/core';
import type { LogEntry } from '@oxyhq/core';

import {
  MOCK_EXPO_PUSH_TOKEN,
  __resetNotificationAdapter,
  __resetOxyState,
  __setOxyState,
  getExpoPushToken,
  makeMockOxyServices,
  requestNotificationPermission,
  type MockOxyServices,
} from '@/__mocks__/oxyhq-services';
import { OXY_CLIENT_ID } from '@/constants/oxy';
import { usePushRegistration } from '@/hooks/usePushRegistration';

let pushNotifications = true;

// Hoisted above the imports by ts-jest, so the hook binds to this stub. The
// device adapter itself is `@oxyhq/services` (already stubbed at the package
// boundary), so the real orchestration and the real Inbox client-id wiring stay
// under test.
jest.mock('@/contexts/inbox-prefs-context', () => ({
  useInboxPrefs: () => ({ prefs: { pushNotifications }, setPref: jest.fn(), loaded: true }),
}));

function installSession(
  overrides: { canUsePrivateApi?: boolean; userId?: string; deviceId?: string } = {},
): MockOxyServices {
  const oxyServices = makeMockOxyServices();
  __setOxyState({
    isAuthenticated: overrides.canUsePrivateApi ?? true,
    canUsePrivateApi: overrides.canUsePrivateApi ?? true,
    user: { id: overrides.userId ?? 'user-1', username: 'nate' },
    oxyServices,
    sessionClient: overrides.deviceId
      ? { getState: () => ({ deviceId: overrides.deviceId ?? '' }) }
      : null,
  });
  return oxyServices;
}

/** Lets any queued microtask work run before asserting a negative. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

let entries: LogEntry[] = [];

describe('usePushRegistration', () => {
  beforeEach(() => {
    pushNotifications = true;
    __resetOxyState();
    __resetNotificationAdapter();

    entries = [];
    configureLogger({
      level: 'debug',
      sink: (entry) => {
        entries.push(entry);
      },
    });
  });

  afterEach(() => {
    resetLoggerConfig();
  });

  it('registers the Expo push token through the SDK, scoped to the Inbox client id', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });

    renderHook(() => usePushRegistration());

    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));
    expect(oxyServices.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: MOCK_EXPO_PUSH_TOKEN,
      platform: 'ios',
      clientId: OXY_CLIENT_ID,
    });
  });

  it("threads the device session's deviceId when one is available", async () => {
    const oxyServices = installSession({ canUsePrivateApi: true, deviceId: 'device-9' });

    renderHook(() => usePushRegistration());

    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));
    expect(oxyServices.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-9' }),
    );
  });

  it('does not register before a bearer exists', async () => {
    const oxyServices = installSession({ canUsePrivateApi: false });

    renderHook(() => usePushRegistration());
    await settle();

    expect(oxyServices.registerPushToken).not.toHaveBeenCalled();
  });

  it('registers as soon as the session resolves', async () => {
    const oxyServices = installSession({ canUsePrivateApi: false });

    renderHook(() => usePushRegistration());
    expect(oxyServices.registerPushToken).not.toHaveBeenCalled();

    act(() => {
      __setOxyState({ isAuthenticated: true, canUsePrivateApi: true });
    });

    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));
  });

  it('does not register while the preference is off', async () => {
    pushNotifications = false;
    const oxyServices = installSession({ canUsePrivateApi: true });

    renderHook(() => usePushRegistration());
    await settle();

    expect(oxyServices.registerPushToken).not.toHaveBeenCalled();
    expect(getExpoPushToken).not.toHaveBeenCalled();
    // The preference IS the consent, so with it off the OS dialog must never
    // appear — the adapter is not even asked.
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('retires the registered token through the SDK when the preference is turned off', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });

    const { rerender } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));

    pushNotifications = false;
    await act(async () => {
      rerender();
    });

    expect(oxyServices.unregisterPushToken).toHaveBeenCalledTimes(1);
    expect(oxyServices.unregisterPushToken).toHaveBeenCalledWith(MOCK_EXPO_PUSH_TOKEN);
  });

  it('retires the registered token on unmount', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });

    const { unmount } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));

    await act(async () => {
      unmount();
    });

    expect(oxyServices.unregisterPushToken).toHaveBeenCalledWith(MOCK_EXPO_PUSH_TOKEN);
  });

  it('does not attempt a retirement once the bearer is gone', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });

    const { unmount } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));

    // Sign-out: `DELETE /notifications/push-token` is scoped to the identity
    // holding the bearer, so with none left the call could only 401.
    oxyServices.getAccessToken.mockReturnValue(null);
    await act(async () => {
      unmount();
    });

    expect(oxyServices.unregisterPushToken).not.toHaveBeenCalled();
  });

  it('retires a registration that completed after the preference was turned off', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });

    let releaseToken: (token: string) => void = () => undefined;
    getExpoPushToken.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseToken = resolve;
      }),
    );

    const { rerender } = renderHook(() => usePushRegistration());

    pushNotifications = false;
    await act(async () => {
      rerender();
    });
    expect(oxyServices.registerPushToken).not.toHaveBeenCalled();

    await act(async () => {
      releaseToken(MOCK_EXPO_PUSH_TOKEN);
      await Promise.resolve();
    });

    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(oxyServices.unregisterPushToken).toHaveBeenCalledWith(MOCK_EXPO_PUSH_TOKEN),
    );
  });

  it('reports a registration failure instead of swallowing it', async () => {
    const oxyServices = installSession({ canUsePrivateApi: true });
    oxyServices.registerPushToken.mockRejectedValue(new Error('offline'));

    renderHook(() => usePushRegistration());

    await waitFor(() => expect(oxyServices.registerPushToken).toHaveBeenCalledTimes(1));
    await settle();

    expect(entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message)).toEqual([
      '[inbox] push token registration failed',
    ]);
    expect(oxyServices.unregisterPushToken).not.toHaveBeenCalled();
  });
});
