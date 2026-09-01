/**
 * `installForegroundNotificationHandler` — the one-shot, process-wide install.
 *
 * `setNotificationHandler` is global, last-writer-wins process state, so two
 * callers racing on a cold boot must not both reach it: the latch is set BEFORE
 * the adapter's first `await`, which is what makes concurrent calls safe. The
 * latch lives for the life of the module registry, so this file owns it alone —
 * jest gives each test file its own registry — and the tests below run in order
 * against a single install.
 */

import { configureLogger, resetLoggerConfig } from '@oxyhq/core';
import type { LogEntry } from '@oxyhq/core';
import { Platform } from 'react-native';
import type { ForegroundPresentation } from '../../src/notifications/deviceNotifications';
import { installForegroundNotificationHandler } from '../../src/notifications/deviceNotifications';

const mockNotifications = {
  setNotificationHandler: jest.fn(),
};

jest.mock('expo-notifications', () => ({ __esModule: true, ...mockNotifications }), {
  virtual: true,
});

interface NotificationBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

type HandleNotification = (notification: {
  request: { content: { data: unknown } };
}) => Promise<NotificationBehavior>;

/** The handler the adapter actually registered with `expo-notifications`. */
function registeredHandler(): HandleNotification {
  const handler = mockNotifications.setNotificationHandler.mock.calls[0]?.[0]?.handleNotification;
  if (typeof handler !== 'function') {
    throw new Error('no foreground handler was registered');
  }
  return handler as HandleNotification;
}

function notificationWith(data: unknown) {
  return {
    request: {
      identifier: 'notification-1',
      content: { title: 'Untrusted title', body: 'Untrusted body', data },
    },
  };
}

/** The decision function of the caller that wins the race below. */
const decideFirst = jest.fn<ForegroundPresentation, [unknown]>(() => 'show');
/** The decision function of the caller that loses it — must never be consulted. */
const decideSecond = jest.fn<ForegroundPresentation, [unknown]>(() => 'suppress');

describe('installForegroundNotificationHandler', () => {
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

  // Ordered on purpose: the latch is process state, so the race has to run
  // first, against an unconsumed latch.
  it('installs exactly one handler when two callers race', async () => {
    const results = await Promise.all([
      installForegroundNotificationHandler(decideFirst),
      installForegroundNotificationHandler(decideSecond),
    ]);

    // Deterministic, not merely "one of them": the latch is claimed
    // synchronously, so the caller that got there first is the one that installs.
    expect(results).toEqual([true, false]);
    expect(mockNotifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('stays installed — a later call is inert and never re-registers', async () => {
    await expect(installForegroundNotificationHandler(decideSecond)).resolves.toBe(false);

    expect(mockNotifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });

  it('consults the winning decision function with the raw payload — and nothing else', async () => {
    await registeredHandler()(notificationWith({ kind: 'approval', code: 'abc' }));

    // `content.data` only: the untrusted title/body are never handed over.
    expect(decideFirst).toHaveBeenCalledWith({ kind: 'approval', code: 'abc' });
    expect(decideSecond).not.toHaveBeenCalled();
  });

  it('shows the banner and lists the notification on a "show" verdict', async () => {
    decideFirst.mockReturnValue('show');

    await expect(registeredHandler()(notificationWith({ kind: 'approval' }))).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      // Never a sound: the app is foregrounded, the user is already looking at
      // the screen the banner appears on.
      shouldPlaySound: false,
      // Never a badge: unread counts are an app concept this adapter has no
      // view of.
      shouldSetBadge: false,
    });
  });

  it('presents nothing on a "suppress" verdict', async () => {
    decideFirst.mockReturnValue('suppress');

    await expect(registeredHandler()(notificationWith({ kind: 'unknown' }))).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });
});
