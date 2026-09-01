/**
 * Registering this installation with the Oxy push registry.
 *
 * Push is cross-cutting, so BOTH of its reusable halves belong to the SDK:
 * `@oxyhq/core` owns the bearer-authed transport (`registerPushToken` /
 * `unregisterPushToken`, which validates the token shape before a request leaves
 * the client), and `@oxyhq/services` owns the `expo-notifications` adapter —
 * permission, platform tag, EXPO push token — that core, barred from importing
 * any `expo-*` module, cannot host. Every Oxy app needs that adapter verbatim,
 * so no app keeps a copy of it.
 *
 * What is left here is the part that is genuinely Inbox's: the orchestration
 * around those two, and the binding to Inbox's registered client id. It is pure
 * — every side effect is injected — so the rules that matter are testable
 * without a device:
 *
 *   1. Nothing is sent until the platform is supported, the OS permission is
 *      granted, AND a token exists.
 *   2. The token that IS sent came from `getExpoPushTokenAsync`. A raw APNs/FCM
 *      device token registers "successfully" and then silently fails at delivery
 *      forever, which is why the adapter never obtains one in the first place.
 *
 * Registration additionally requires a SESSION — `registerPushToken` is
 * bearer-authed — which is the caller's precondition (`usePushRegistration`
 * gates on `canUsePrivateApi`).
 */

import type { PushTokenPlatform, RegisterPushTokenInput } from '@oxyhq/core';
import {
  getExpoPushToken,
  pushTokenPlatform,
  requestNotificationPermission,
} from '@oxyhq/services';

import { OXY_CLIENT_ID } from '@/constants/oxy';

/**
 * The `@oxyhq/core` surface this module drives, satisfied by `OxyServices`.
 *
 * Only the register half: retiring a token is a single `unregisterPushToken`
 * call the caller already holds the token for, so it goes straight to the SDK
 * rather than through a wrapper here.
 */
export interface PushTokenRegistrar {
  registerPushToken: (input: RegisterPushTokenInput) => Promise<void>;
}

/** Device facts the orchestration reads. Injected so tests need no native modules. */
export interface PushTokenEnvironment {
  /** Whether notifications are permitted, prompting at most once if needed. */
  requestNotificationPermission: () => Promise<boolean>;
  /** This installation's Expo push token, or null when one cannot be minted. */
  getExpoPushToken: () => Promise<string | null>;
  /** Platform tag for the registry, or null on a platform Inbox cannot reach. */
  pushTokenPlatform: () => PushTokenPlatform | null;
}

export type PushRegistrationOutcome =
  | { status: 'registered'; expoPushToken: string }
  | { status: 'skipped'; reason: 'unsupported-platform' | 'permission-not-granted' | 'no-token' };

/**
 * Register this installation's Expo push token for the currently signed-in
 * identity, scoped to the given application.
 *
 * The `clientId` scope resolves server-side to the registering `Application`, so
 * a delivery can target this app's installations instead of every push token the
 * identity owns. `deviceId` ties the row to the device session, so the server can
 * retire it when that session goes away.
 *
 * Idempotent server-side, so re-registering on a cold boot is free.
 *
 * @throws Whatever `registerPushToken` throws — including its explicit rejection
 *   of a non-Expo token. Callers treat push registration as best-effort and log.
 */
export async function registerInstallationPushToken(
  registrar: PushTokenRegistrar,
  environment: PushTokenEnvironment,
  options: { clientId: string; deviceId?: string },
): Promise<PushRegistrationOutcome> {
  const platform = environment.pushTokenPlatform();
  if (!platform) {
    return { status: 'skipped', reason: 'unsupported-platform' };
  }

  // Permission first: minting a token without it fails on iOS anyway, and a
  // registration the user never consented to is not one we want to hold.
  // Prompting is correct here — in Inbox the "Push notifications" preference IS
  // the consent, so reaching this line is the user asking to be notified. The
  // adapter prompts at most once per installation.
  if (!(await environment.requestNotificationPermission())) {
    return { status: 'skipped', reason: 'permission-not-granted' };
  }

  const expoPushToken = await environment.getExpoPushToken();
  if (!expoPushToken) {
    // The adapter has already logged WHY (no project id, denied, offline).
    return { status: 'skipped', reason: 'no-token' };
  }

  const input: RegisterPushTokenInput = {
    expoPushToken,
    platform,
    clientId: options.clientId,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
  };
  await registrar.registerPushToken(input);

  return { status: 'registered', expoPushToken };
}

/** The SDK's device adapter, bound once so call sites stay declarative. */
const deviceEnvironment: PushTokenEnvironment = {
  requestNotificationPermission,
  getExpoPushToken,
  pushTokenPlatform,
};

/**
 * {@link registerInstallationPushToken} bound to this device and to Inbox's
 * registered `clientId`.
 */
export function registerInboxPushToken(
  registrar: PushTokenRegistrar,
  deviceId?: string,
): Promise<PushRegistrationOutcome> {
  return registerInstallationPushToken(registrar, deviceEnvironment, {
    clientId: OXY_CLIENT_ID,
    ...(deviceId ? { deviceId } : {}),
  });
}
