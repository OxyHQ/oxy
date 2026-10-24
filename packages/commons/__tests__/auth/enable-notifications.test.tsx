/**
 * The last onboarding step (notification permission).
 *
 * 1. It is a ROOT route outside both `Stack.Protected` guards. The username step
 *    completes onboarding, which turns the `(auth)` guard off in the same
 *    render, so the step used to be unreachable after an online onboarding:
 *    Commons never asked for the permission and push sign-in requests could not
 *    reach the phone.
 * 2. A sign-in that fails with anything but a network error is shown on the
 *    screen. It used to be rethrown past the button handler, leaving
 *    `isSigningIn` set and the screen frozen behind its spinner.
 * 3. "Not now" finishes onboarding without the system prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { __getMockRouter } from '@/__mocks__/expo-router';
import { requestNotificationPermission, useAuthStore } from '@/__mocks__/oxy-services';

jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock(
  'expo-constants',
  () => ({ __esModule: true, default: { executionEnvironment: 'bare' } }),
  {
    virtual: true,
  },
);
const getPublicKeyMock = jest.fn(async (): Promise<string | null> => 'pubkey');
jest.mock('@oxy.so/core/crypto', () => ({
  KeyManager: { getPublicKey: () => getPublicKeyMock() },
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  registerVaultPushToken: jest.fn(async () => ({ status: 'registered' })),
  vaultChannelCopy: () => ({ name: 'n', description: 'd' }),
}));
jest.mock('@/constants/auth', () => ({ STORE_UPDATE_DELAY_MS: 0 }));

import { useAuthHandlers } from '@/hooks/auth/useAuthHandlers';

const APP = join(__dirname, '..', '..', 'app');
const read = (path: string) => readFileSync(join(APP, path), 'utf8');

function renderHandlers(signIn: jest.Mock, isAuthenticated = false) {
  const setAuthError = jest.fn();
  const setSigningIn = jest.fn();
  const hook = renderHook(() =>
    useAuthHandlers({
      signIn,
      oxyServices: {} as never,
      setAuthError,
      setSigningIn,
      isAuthenticated,
    }),
  );
  return { hook, setAuthError, setSigningIn };
}

describe('the notifications onboarding step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.getState.mockReturnValue({ isAuthenticated: true });
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
  });

  describe('routing', () => {
    const rootLayout = read('_layout.tsx');

    it('is a root route registered outside every Stack.Protected guard', () => {
      const screen = rootLayout.indexOf('name="enable-notifications"');
      expect(screen).toBeGreaterThan(-1);
      // Walk the guards: the screen must not sit between an opening
      // <Stack.Protected> and its closing tag.
      const before = rootLayout.slice(0, screen);
      const opened = before.match(/<Stack\.Protected\b/g)?.length ?? 0;
      const closed = before.match(/<\/Stack\.Protected>/g)?.length ?? 0;
      expect(opened).toBe(closed);
    });

    it('is where both username steps go, and no (auth) notifications screen is left', () => {
      expect(read('(auth)/create-identity/username.tsx')).toContain("'/enable-notifications'");
      expect(read('(auth)/import-identity/username.tsx')).toContain("'/enable-notifications'");
      expect(read('(auth)/create-identity/_layout.tsx')).not.toMatch(/name="notifications"/);
      expect(read('(auth)/import-identity/_layout.tsx')).not.toMatch(/name="notifications"/);
    });
  });

  describe('a sign-in that fails for a reason other than the network', () => {
    it('shows the error and releases the screen instead of throwing', async () => {
      const signIn = jest.fn(async () => {
        throw Object.assign(new Error('User not found'), { status: 404 });
      });
      const { hook, setAuthError, setSigningIn } = renderHandlers(signIn);

      await act(async () => {
        await expect(hook.result.current.handleRequestNotifications()).resolves.toBeUndefined();
      });

      expect(signIn).toHaveBeenCalledTimes(1);
      expect(setSigningIn).toHaveBeenLastCalledWith(false);
      expect(setAuthError).toHaveBeenLastCalledWith(expect.any(String));
      expect(setAuthError.mock.lastCall?.[0]).toBeTruthy();
      expect(requestNotificationPermission).not.toHaveBeenCalled();
      expect(__getMockRouter().replace).not.toHaveBeenCalled();
    });
  });

  describe('signed in', () => {
    it('asks for the permission, then opens the vault', async () => {
      const { hook } = renderHandlers(jest.fn(), true);
      await act(async () => {
        await hook.result.current.handleRequestNotifications();
      });
      expect(requestNotificationPermission).toHaveBeenCalledTimes(1);
      expect(__getMockRouter().replace).toHaveBeenCalledWith('/(tabs)/(id)');
    });

    it('"Not now" opens the vault without the system prompt', async () => {
      const { hook } = renderHandlers(jest.fn(), true);
      await act(async () => {
        await hook.result.current.handleSkipNotifications();
      });
      expect(requestNotificationPermission).not.toHaveBeenCalled();
      expect(__getMockRouter().replace).toHaveBeenCalledWith('/(tabs)/(id)');
    });
  });

  it('"Not now" without a session signs in first', async () => {
    const signIn = jest.fn(async () => ({ id: 'u1' }));
    const { hook } = renderHandlers(signIn, false);
    await act(async () => {
      await hook.result.current.handleSkipNotifications();
    });
    expect(signIn).toHaveBeenCalledWith('pubkey');
    expect(requestNotificationPermission).not.toHaveBeenCalled();
    expect(__getMockRouter().replace).toHaveBeenCalledWith('/(tabs)/(id)');
  });
});
