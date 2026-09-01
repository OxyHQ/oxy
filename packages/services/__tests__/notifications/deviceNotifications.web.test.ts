/**
 * The device-notifications adapter is NATIVE-ONLY BY CONSTRUCTION.
 *
 * "By construction" is the assertion this file exists to make: on web the null /
 * no-op result must be reached WITHOUT `expo-notifications` ever being imported.
 * A `try/catch` that swallows a failed import would look identical from the
 * outside, so the proof here is a counter bumped inside the mock factory —
 * jest calls a virtual module's factory exactly once, on first require, so a
 * count of zero means the module was never requested at all.
 *
 * This also gets its own file because the foreground handler is a one-shot,
 * process-wide latch: proving "web never registers a handler" needs an unconsumed
 * latch, and `deviceNotifications.foreground.test.ts` consumes it. Jest gives
 * each test file its own module registry, so this file gets a fresh one.
 */

import { Platform } from 'react-native';
import {
  getExpoPushToken,
  hasNotificationPermission,
  installForegroundNotificationHandler,
  pushTokenPlatform,
  requestNotificationPermission,
  subscribeToNotificationResponses,
  takeLaunchNotificationData,
} from '../../src/notifications/deviceNotifications';

let mockNotificationsImports = 0;
let mockConstantsImports = 0;

jest.mock(
  'expo-notifications',
  () => {
    mockNotificationsImports += 1;
    return { __esModule: true };
  },
  { virtual: true },
);

jest.mock(
  'expo-constants',
  () => {
    mockConstantsImports += 1;
    return { __esModule: true, default: { easConfig: null, expoConfig: null } };
  },
  { virtual: true },
);

describe('device notifications on web', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'web';
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('reports no push platform — browser push is not wired', () => {
    expect(pushTokenPlatform()).toBeNull();
  });

  it('resolves the no-op result for every entry point without importing the native modules', async () => {
    await expect(hasNotificationPermission()).resolves.toBe(false);
    await expect(requestNotificationPermission()).resolves.toBe(false);
    await expect(getExpoPushToken()).resolves.toBeNull();
    await expect(takeLaunchNotificationData()).resolves.toBeNull();
    await expect(installForegroundNotificationHandler(() => 'show')).resolves.toBe(false);

    // The unsubscribe handle is always safe to call, even when nothing was
    // subscribed — callers unmount the same way on every platform.
    const unsubscribe = await subscribeToNotificationResponses(() => undefined);
    expect(() => unsubscribe()).not.toThrow();

    expect(mockNotificationsImports).toBe(0);
    expect(mockConstantsImports).toBe(0);
  });

  it('stays inert when the foreground handler is installed repeatedly', async () => {
    await expect(installForegroundNotificationHandler(() => 'show')).resolves.toBe(false);
    await expect(installForegroundNotificationHandler(() => 'show')).resolves.toBe(false);

    expect(mockNotificationsImports).toBe(0);
  });
});
