/**
 * The native half of the `expo-notifications` adapter.
 *
 * `expo-notifications` and `expo-constants` are stubbed so the adapter's real
 * logic runs against a controllable module.
 *
 * The single most important assertion in this file is that
 * `getDevicePushTokenAsync` is NEVER called. Oxy delivers push by POSTing to
 * `https://exp.host/--/api/v2/push/send`, which only accepts an
 * `ExponentPushToken[…]`; a raw APNs/FCM token registers "successfully" and then
 * silently fails at delivery forever. The only way to make that class of bug
 * impossible is to never obtain one — so a mutation of `getExpoPushTokenAsync`
 * into `getDevicePushTokenAsync` has to fail here.
 */

import { configureLogger, resetLoggerConfig } from '@oxyhq/core';
import type { LogEntry } from '@oxyhq/core';
import { Platform } from 'react-native';
import {
  getExpoPushToken,
  hasNotificationPermission,
  pushTokenPlatform,
  requestNotificationPermission,
  subscribeToNotificationResponses,
  takeLaunchNotificationData,
} from '../../src/notifications/deviceNotifications';

const mockNotifications = {
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  getLastNotificationResponse: jest.fn(),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
};

const mockConstants: {
  easConfig: { projectId?: string } | null;
  expoConfig: { extra?: Record<string, unknown> } | null;
} = {
  easConfig: null,
  expoConfig: null,
};

jest.mock('expo-notifications', () => ({ __esModule: true, ...mockNotifications }), {
  virtual: true,
});

jest.mock('expo-constants', () => ({ __esModule: true, default: mockConstants }), {
  virtual: true,
});

const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const RAW_DEVICE_TOKEN = '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad';
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

let entries: LogEntry[] = [];

function warnings(): string[] {
  return entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
}

/** Place the project id where `expo.extra.eas.projectId` resolves it from. */
function setEasProjectId(projectId: string | null): void {
  mockConstants.easConfig = null;
  mockConstants.expoConfig = { extra: { eas: { projectId: projectId ?? '' } } };
}

/** A notification response carrying `data` and display text the adapter must ignore. */
function responseWith(data: unknown) {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        identifier: 'notification-1',
        content: { title: 'Untrusted title', body: 'Untrusted body', data },
      },
    },
  };
}

describe('device notifications adapter', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    entries = [];
    configureLogger({
      level: 'debug',
      sink: (entry) => {
        entries.push(entry);
      },
    });

    Platform.OS = 'ios';
    setEasProjectId(PROJECT_ID);

    for (const fn of Object.values(mockNotifications)) fn.mockReset();

    mockNotifications.getPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    });
    mockNotifications.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: EXPO_TOKEN });
    mockNotifications.getDevicePushTokenAsync.mockResolvedValue({
      type: 'apns',
      data: RAW_DEVICE_TOKEN,
    });
    mockNotifications.getLastNotificationResponse.mockReturnValue(null);
    mockNotifications.addNotificationResponseReceivedListener.mockReturnValue({
      remove: jest.fn(),
    });
  });

  afterEach(() => {
    Platform.OS = originalOS;
    mockConstants.easConfig = null;
    mockConstants.expoConfig = null;
    resetLoggerConfig();
  });

  describe('pushTokenPlatform', () => {
    it.each(['ios', 'android'] as const)('reports %s', (os) => {
      Platform.OS = os;

      expect(pushTokenPlatform()).toBe(os);
    });
  });

  describe('getExpoPushToken', () => {
    it('mints an EXPO push token and never touches the raw device token', async () => {
      await expect(getExpoPushToken()).resolves.toBe(EXPO_TOKEN);

      expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
      expect(mockNotifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    });

    it('mints against the configured EAS project id', async () => {
      await getExpoPushToken();

      expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
      });
    });

    it('prefers the project id an EAS build injects', async () => {
      mockConstants.easConfig = { projectId: 'eas-build-project' };

      await getExpoPushToken();

      expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
        projectId: 'eas-build-project',
      });
    });

    it('warns with the reason — and never mints — when no EAS project id is configured', async () => {
      // The live path for both current consumers: `expo.extra.eas.projectId` is
      // an empty string, so nothing can be minted for the whole build.
      setEasProjectId(null);

      await expect(getExpoPushToken()).resolves.toBeNull();

      expect(mockNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(warnings()).toHaveLength(1);
      // Diagnosable: names the exact config key AND the consequence.
      expect(warnings()[0]).toContain('expo.extra.eas.projectId');
      expect(warnings()[0]).toContain('push is disabled for this build');
    });

    it('reports the missing project id as a diagnostic, not a rejection', async () => {
      setEasProjectId(null);

      // A throw here would surface to callers as an opaque failure and get
      // filed under "permission denied / offline"; the whole point of
      // pre-resolving the project id is that it does not.
      await expect(getExpoPushToken()).resolves.toBeNull();
    });

    it('warns once with the underlying error when the mint itself fails', async () => {
      mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('network down'));

      await expect(getExpoPushToken()).resolves.toBeNull();

      expect(warnings()).toEqual(['could not mint an Expo push token']);
    });

    it('resolves null (never an empty token) and warns when the service returns nothing', async () => {
      mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: '' });

      await expect(getExpoPushToken()).resolves.toBeNull();

      expect(warnings()).toHaveLength(1);
    });
  });

  describe('hasNotificationPermission', () => {
    it('reports a granted permission without ever prompting', async () => {
      await expect(hasNotificationPermission()).resolves.toBe(true);

      expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('reports an ungranted permission without ever prompting', async () => {
      mockNotifications.getPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: true,
        status: 'undetermined',
      });

      await expect(hasNotificationPermission()).resolves.toBe(false);

      expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('degrades to not-granted when the permission cannot be read', async () => {
      mockNotifications.getPermissionsAsync.mockRejectedValue(new Error('module not linked'));

      await expect(hasNotificationPermission()).resolves.toBe(false);

      expect(warnings()).toEqual(['could not read the notification permission']);
    });
  });

  describe('requestNotificationPermission', () => {
    it('does not show a system dialog when the permission is already granted', async () => {
      await expect(requestNotificationPermission()).resolves.toBe(true);

      expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('prompts exactly once when the permission is undetermined', async () => {
      mockNotifications.getPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: true,
        status: 'undetermined',
      });

      await expect(requestNotificationPermission()).resolves.toBe(true);

      expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('does not re-prompt an installation that already declined for good', async () => {
      mockNotifications.getPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: false,
        status: 'denied',
      });

      await expect(requestNotificationPermission()).resolves.toBe(false);

      expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('reports a fresh denial as not granted', async () => {
      mockNotifications.getPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: true,
        status: 'undetermined',
      });
      mockNotifications.requestPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: false,
        status: 'denied',
      });

      await expect(requestNotificationPermission()).resolves.toBe(false);
    });
  });

  describe('takeLaunchNotificationData', () => {
    it('resolves null when the app was not launched from a notification', async () => {
      await expect(takeLaunchNotificationData()).resolves.toBeNull();

      expect(mockNotifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    });

    it('returns the routing payload and clears the response so it is taken once', async () => {
      mockNotifications.getLastNotificationResponse.mockReturnValue(
        responseWith({ kind: 'approval', code: 'abc' }),
      );

      await expect(takeLaunchNotificationData()).resolves.toEqual({
        kind: 'approval',
        code: 'abc',
      });

      expect(mockNotifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    });

    it('still returns the payload when clearing is unsupported, and says so', async () => {
      mockNotifications.getLastNotificationResponse.mockReturnValue(responseWith({ kind: 'x' }));
      mockNotifications.clearLastNotificationResponse.mockImplementation(() => {
        throw new Error('unsupported on this OS version');
      });

      await expect(takeLaunchNotificationData()).resolves.toEqual({ kind: 'x' });

      expect(warnings()).toEqual(['could not clear the launching notification response']);
    });

    it('degrades to null when the launching notification cannot be read', async () => {
      mockNotifications.getLastNotificationResponse.mockImplementation(() => {
        throw new Error('module not linked');
      });

      await expect(takeLaunchNotificationData()).resolves.toBeNull();

      expect(warnings()).toEqual(['could not read the launching notification']);
    });
  });

  describe('subscribeToNotificationResponses', () => {
    it('forwards only the routing payload of a tapped notification', async () => {
      const listener = jest.fn();
      await subscribeToNotificationResponses(listener);

      const [registered] = mockNotifications.addNotificationResponseReceivedListener.mock.calls[0];
      registered(responseWith({ kind: 'approval' }));

      // `content.data` only — the untrusted title/body never reach the caller.
      expect(listener).toHaveBeenCalledWith({ kind: 'approval' });
    });

    it('removes the native subscription on unsubscribe', async () => {
      const remove = jest.fn();
      mockNotifications.addNotificationResponseReceivedListener.mockReturnValue({ remove });

      const unsubscribe = await subscribeToNotificationResponses(() => undefined);
      unsubscribe();

      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('returns a safe no-op unsubscribe when the subscription cannot be established', async () => {
      mockNotifications.addNotificationResponseReceivedListener.mockImplementation(() => {
        throw new Error('module not linked');
      });

      const unsubscribe = await subscribeToNotificationResponses(() => undefined);

      expect(() => unsubscribe()).not.toThrow();
      expect(warnings()).toEqual(['could not subscribe to notification taps']);
    });
  });
});
