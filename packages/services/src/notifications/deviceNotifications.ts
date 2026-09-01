/**
 * The ONE place `@oxyhq/services` touches `expo-notifications`.
 *
 * Every Oxy app that receives push needs the identical adapter — native-only,
 * dynamically imported, reading the OS permission and minting an EXPO push
 * token — so it lives here instead of being copied into each app. The
 * bearer-authenticated transport (`registerPushToken` / `unregisterPushToken`)
 * already lives in `@oxyhq/core`; core may never import an `expo-*` module, and
 * this adapter is the Expo-side half that closes that gap.
 *
 * ## Native-only by construction
 *
 * Every entry point resolves its null/no-op result from `Platform.OS` BEFORE the
 * dynamic `import()`, so a web bundle never requests `expo-notifications` at all.
 * `expo-notifications` and `expo-constants` are OPTIONAL peer dependencies: an
 * app that does not use push never installs them, and a build without them
 * degrades to "notifications unavailable" rather than throwing at
 * module-evaluation time.
 *
 * ## The token is an EXPO push token — never a raw device token
 *
 * {@link getExpoPushToken} calls `getExpoPushTokenAsync()`, which returns the
 * `ExponentPushToken[…]` handle Expo's push service delivers through — the only
 * form it accepts. `getDevicePushTokenAsync()` — the raw APNs/FCM token — is
 * deliberately NOT used anywhere: registering one of those looks entirely
 * successful (the row is stored, the endpoint returns 200) and then every push
 * silently fails at delivery time. `@oxyhq/core`'s `registerPushToken` rejects a
 * raw device token before sending, and this module is the reason it never has to.
 *
 * ## The payload is untrusted
 *
 * Nothing here surfaces a notification's `title` / `body` / `subtitle`. The only
 * payload that leaves this module is the raw `content.data` — the routing keys —
 * typed `unknown`, so a caller has to validate it before acting on it and there
 * is no exported shape that invites rendering push-delivered text. The
 * foreground handler likewise answers with a visibility verdict and nothing else.
 */

import { createLogger } from '@oxyhq/core';
import type { PushTokenPlatform } from '@oxyhq/core';
import { Platform } from 'react-native';

const log = createLogger('deviceNotifications');

type NotificationsModule = typeof import('expo-notifications');
type ConstantsModule = typeof import('expo-constants');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Load `expo-notifications`, or `null` when it cannot serve this platform/build.
 *
 * The web guard runs before the `import()`, so a web bundle never reaches for the
 * native module. The dynamic import is intentional: the module registry caches
 * it, so repeated calls are cheap and no module-level mutable cache is
 * introduced here.
 */
async function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === 'web') {
    return null;
  }
  try {
    return await import('expo-notifications');
  } catch (error) {
    log.warn(
      'expo-notifications is unavailable in this build — push is disabled',
      { method: 'loadNotifications' },
      error,
    );
    return null;
  }
}

/**
 * The EAS project id an Expo push token is minted against, or `null` when the
 * app config carries none.
 *
 * Resolved exactly the way `expo-notifications` resolves it internally
 * (`easConfig.projectId`, then `expoConfig.extra.eas.projectId`) and then handed
 * BACK to `getExpoPushTokenAsync` explicitly, so the two can never disagree.
 * Reading it here is what turns "no project id" from an opaque
 * `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID` rejection into a named, actionable state
 * instead of one more entry in the indistinguishable "permission denied /
 * offline" bucket.
 *
 * A missing `expo-constants` lands on the same `null` outcome — the single
 * actionable warning is emitted once by the caller, so this path only records
 * the extra detail at debug level rather than warning twice for one condition.
 */
async function easProjectId(): Promise<string | null> {
  let constants: ConstantsModule['default'];
  try {
    constants = (await import('expo-constants')).default;
  } catch (error) {
    log.debug(
      'expo-constants is unavailable in this build — no EAS project id can be resolved',
      { method: 'easProjectId' },
      error,
    );
    return null;
  }

  const fromEasConfig = constants.easConfig?.projectId;
  if (typeof fromEasConfig === 'string' && fromEasConfig.length > 0) {
    return fromEasConfig;
  }

  const extra: unknown = constants.expoConfig?.extra;
  const eas = isRecord(extra) ? extra.eas : undefined;
  const projectId = isRecord(eas) ? eas.projectId : undefined;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/**
 * The platform tag the push-token registry stores this installation under, or
 * `null` on a platform Oxy does not deliver push to.
 *
 * Synchronous and import-free — the answer is a property of the bundle, not of
 * any native module.
 *
 * Web is `null` on purpose: the registry accepts a `web` platform, but browser
 * push needs a VAPID key + service-worker subscription no Oxy app has wired, so
 * there is no token to register and claiming otherwise would store a row nothing
 * can ever deliver to.
 */
export function pushTokenPlatform(): PushTokenPlatform | null {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null;
}

/**
 * Whether the OS notification permission is ALREADY granted.
 *
 * Never prompts, so an app can re-check on every cold boot without ever asking
 * the user twice. Use {@link requestNotificationPermission} for the one place
 * that is allowed to show the system dialog.
 */
export async function hasNotificationPermission(): Promise<boolean> {
  const notifications = await loadNotifications();
  if (!notifications) {
    return false;
  }
  try {
    const permissions = await notifications.getPermissionsAsync();
    return permissions.granted === true;
  } catch (error) {
    log.warn(
      'could not read the notification permission',
      { method: 'hasNotificationPermission' },
      error,
    );
    return false;
  }
}

/**
 * Ensure the OS notification permission, prompting at most once.
 *
 * An installation that already answered the system dialog is never asked again:
 * an already-granted permission resolves `true` without a second dialog, and a
 * denial with `canAskAgain: false` resolves `false` without issuing a request
 * the OS would silently ignore.
 *
 * @returns Whether notifications are granted once this call is done.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const notifications = await loadNotifications();
  if (!notifications) {
    return false;
  }
  try {
    const existing = await notifications.getPermissionsAsync();
    if (existing.granted === true) {
      return true;
    }
    if (existing.canAskAgain === false) {
      return false;
    }
    const requested = await notifications.requestPermissionsAsync();
    return requested.granted === true;
  } catch (error) {
    log.warn(
      'the notification permission could not be resolved',
      { method: 'requestNotificationPermission' },
      error,
    );
    return false;
  }
}

/**
 * This installation's Expo push token (`ExponentPushToken[…]`), or `null` when
 * one cannot be minted.
 *
 * Deliberately `getExpoPushTokenAsync` — see the module header for why the raw
 * device-token variant is never used.
 *
 * Every `null` is logged with the reason it happened. A missing EAS project id
 * in particular is a BUILD MISCONFIGURATION, not a user state: no token can ever
 * be minted, so push is off for every install of that build until the config is
 * fixed. It is reported as such rather than blending into the
 * indistinguishable "permission denied / offline" bucket.
 */
export async function getExpoPushToken(): Promise<string | null> {
  const notifications = await loadNotifications();
  if (!notifications) {
    return null;
  }

  const projectId = await easProjectId();
  if (!projectId) {
    log.warn(
      'no EAS project id in the app config (expo.extra.eas.projectId) — an Expo push token cannot be minted, so push is disabled for this build',
      { method: 'getExpoPushToken' },
    );
    return null;
  }

  try {
    const token = await notifications.getExpoPushTokenAsync({ projectId });
    if (token.data.length === 0) {
      log.warn('the Expo push service returned an empty token', { method: 'getExpoPushToken' });
      return null;
    }
    return token.data;
  } catch (error) {
    log.warn('could not mint an Expo push token', { method: 'getExpoPushToken' }, error);
    return null;
  }
}

/**
 * Take the payload of the notification that COLD-LAUNCHED the app, if any.
 *
 * "Take" is literal: the response is cleared from `expo-notifications` once
 * read, so a listener attached later in the same launch is not handed the same
 * tap again. Clearing is best-effort across OS/module versions, so a caller that
 * must not act twice still needs its own idempotency ledger.
 *
 * @returns The raw, untrusted `content.data` of the launching notification, or
 *   `null`. Parsing/validation is the caller's job.
 */
export async function takeLaunchNotificationData(): Promise<unknown> {
  const notifications = await loadNotifications();
  if (!notifications) {
    return null;
  }
  try {
    const response = notifications.getLastNotificationResponse();
    if (!response) {
      return null;
    }
    const data: unknown = response.notification.request.content.data;
    try {
      notifications.clearLastNotificationResponse();
    } catch (clearError) {
      log.warn(
        'could not clear the launching notification response',
        { method: 'takeLaunchNotificationData' },
        clearError,
      );
    }
    return data;
  } catch (error) {
    log.warn(
      'could not read the launching notification',
      { method: 'takeLaunchNotificationData' },
      error,
    );
    return null;
  }
}

/**
 * What the OS should do with a notification that arrives while the app is
 * FOREGROUNDED.
 *
 * `'suppress'` is `expo-notifications`' own default for a foregrounded app, so a
 * decision function that only ever returns `'show'` for the payloads it
 * recognises leaves every other notification exactly as it behaves today.
 */
export type ForegroundPresentation = 'show' | 'suppress';

/**
 * Whether the process-wide foreground handler has already been ATTEMPTED.
 *
 * `setNotificationHandler` is global, last-writer-wins process state, so this is
 * a one-shot install rather than something a mount/unmount cycle owns. A failed
 * attempt is deliberately not retried: the only failure modes are permanent for
 * the life of the process (web, a build without the native module, a native
 * module that threw on registration).
 *
 * Module-scoped and only ever touched from an async install call — never read
 * during render, so the React Compiler has no memoizable position to freeze it
 * into.
 */
let foregroundHandlerAttempted = false;

/**
 * Install the ONE process-wide handler that decides whether an incoming
 * notification is shown while the app is in the FOREGROUND.
 *
 * Without a handler, `expo-notifications` shows nothing at all while the app is
 * open — which is exactly when a time-critical notification (a "Sign in with
 * Oxy" approval request, say) matters most, because the user is already holding
 * the phone.
 *
 * The handler ONLY decides visibility. It never navigates, never acts on the
 * notification, and never reads the payload for display — `decide` is handed the
 * raw, untrusted `content.data` and may answer nothing but `'show'` /
 * `'suppress'`. Acting on a notification stays with a TAP, routed by
 * {@link subscribeToNotificationResponses}. No notification actions/categories
 * are registered here, so the banner cannot carry an action button.
 *
 * The one-shot latch is set BEFORE the first `await`, so concurrent callers
 * cannot both reach `setNotificationHandler`.
 *
 * @param decide - Maps the raw, untrusted payload to a presentation verdict.
 *   Must not throw; a throw is reported by the OS as a handling error and the
 *   notification is dropped.
 * @returns Whether a handler was installed by THIS call (`false` on a repeat
 *   call, on web, or when the native module is unavailable).
 */
export async function installForegroundNotificationHandler(
  decide: (data: unknown) => ForegroundPresentation,
): Promise<boolean> {
  if (foregroundHandlerAttempted) {
    return false;
  }
  foregroundHandlerAttempted = true;

  const notifications = await loadNotifications();
  if (!notifications) {
    return false;
  }
  try {
    notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data: unknown = notification.request.content.data;
        const show = decide(data) === 'show';
        return {
          // Banner: the whole point — make the notification visible on screen.
          shouldShowBanner: show,
          // Notification centre: so the user can still review it after
          // dismissing the banner.
          shouldShowList: show,
          // No sound: the app is foregrounded, so the user is already looking at
          // the screen the banner appears on.
          shouldPlaySound: false,
          // Badging is an app-level unread concept this adapter has no view of.
          shouldSetBadge: false,
        };
      },
    });
    return true;
  } catch (error) {
    log.warn(
      'could not install the foreground notification handler',
      { method: 'installForegroundNotificationHandler' },
      error,
    );
    return false;
  }
}

/**
 * Subscribe to notification TAPS (responses) while the app is running.
 *
 * @param listener - Receives the raw, untrusted `content.data` of the tapped
 *   notification. Parsing/validation is the caller's job.
 * @returns An unsubscribe function. Safe to call even if the subscription could
 *   not be established.
 */
export async function subscribeToNotificationResponses(
  listener: (data: unknown) => void,
): Promise<() => void> {
  const notifications = await loadNotifications();
  if (!notifications) {
    return () => undefined;
  }
  try {
    const subscription = notifications.addNotificationResponseReceivedListener((response) => {
      listener(response.notification.request.content.data);
    });
    return () => subscription.remove();
  } catch (error) {
    log.warn(
      'could not subscribe to notification taps',
      { method: 'subscribeToNotificationResponses' },
      error,
    );
    return () => undefined;
  }
}
