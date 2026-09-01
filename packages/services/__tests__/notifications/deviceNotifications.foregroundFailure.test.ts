/**
 * A FAILED foreground install is not retried.
 *
 * The one-shot latch is claimed before the install is attempted, so a native
 * module that throws on registration burns it. That is deliberate: every way
 * this can fail (web, a build without the native module, a module that threw)
 * is permanent for the life of the process, so retrying would only re-throw on
 * every cold-boot path that calls it.
 *
 * Own file: the latch is process state and `deviceNotifications.foreground.test.ts`
 * consumes it with a SUCCESSFUL install. Jest gives each test file its own
 * module registry, so this one gets a fresh latch to burn.
 */

import { configureLogger, resetLoggerConfig } from '@oxyhq/core';
import type { LogEntry } from '@oxyhq/core';
import { Platform } from 'react-native';
import { installForegroundNotificationHandler } from '../../src/notifications/deviceNotifications';

const mockNotifications = {
  setNotificationHandler: jest.fn(() => {
    throw new Error('native module not linked');
  }),
};

jest.mock('expo-notifications', () => ({ __esModule: true, ...mockNotifications }), {
  virtual: true,
});

describe('installForegroundNotificationHandler when registration throws', () => {
  const originalOS = Platform.OS;
  const entries: LogEntry[] = [];

  beforeAll(() => {
    Platform.OS = 'ios';
    configureLogger({
      level: 'debug',
      sink: (entry) => {
        entries.push(entry);
      },
    });
  });

  afterAll(() => {
    Platform.OS = originalOS;
    resetLoggerConfig();
  });

  it('reports the failure instead of propagating it, and does not retry', async () => {
    await expect(installForegroundNotificationHandler(() => 'show')).resolves.toBe(false);
    await expect(installForegroundNotificationHandler(() => 'show')).resolves.toBe(false);

    expect(mockNotifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message)).toEqual([
      'could not install the foreground notification handler',
    ]);
  });
});
