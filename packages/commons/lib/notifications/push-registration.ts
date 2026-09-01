/**
 * Registering (and retiring) this installation with the Oxy push registry.
 *
 * Why this exists at all: without a registered push token the platform cannot
 * reach the vault, so "Continue with Oxy" on a desktop has no way to wake the
 * user's phone and the only fallback is a QR (issue #691, Phase 4).
 *
 * The orchestration is pure — every side effect is injected — so the two rules
 * that matter are testable without a device:
 *   1. Nothing is sent until the OS permission is granted AND a token exists.
 *   2. The token that IS sent came from `getExpoPushTokenAsync`; `@oxyhq/core`
 *      rejects anything else before a request leaves the client.
 *
 * Registration additionally requires a SESSION — `registerPushToken` is
 * bearer-authed — which is the caller's precondition (`usePushRegistration`
 * gates on `canUsePrivateApi`).
 *
 * The device half — OS permission, platform tag, and the Expo push token itself
 * — is the shared `@oxyhq/services` adapter, the one place in the ecosystem that
 * touches `expo-notifications`. What stays here is Commons policy: the ORDER the
 * preconditions are checked in, and the Commons `clientId` the registration is
 * scoped to.
 */

import type { PushTokenPlatform, RegisterPushTokenInput } from '@oxyhq/core';
import {
  getExpoPushToken,
  hasNotificationPermission,
  pushTokenPlatform,
} from '@oxyhq/services';
import { OXY_CLIENT_ID } from '@/constants/oxy';

/** The `@oxyhq/core` surface this module drives (satisfied by `OxyServices`). */
export interface PushTokenRegistry {
  registerPushToken: (input: RegisterPushTokenInput) => Promise<void>;
  unregisterPushToken: (expoPushToken: string) => Promise<void>;
}

/** Device facts the orchestration reads. Injected so tests need no native modules. */
export interface PushTokenEnvironment {
  /** Whether the OS notification permission is already granted. Must not prompt. */
  hasNotificationPermission: () => Promise<boolean>;
  /** This installation's Expo push token, or null when one cannot be minted. */
  getExpoPushToken: () => Promise<string | null>;
  /**
   * Platform tag for the registry, or null on a platform Oxy does not deliver
   * push to — which the shared adapter defines as everything except iOS and
   * Android. Web is null there on purpose: browser push would need a VAPID key
   * and a service-worker subscription no Oxy app has wired, so there is no token
   * to register.
   */
  pushTokenPlatform: () => PushTokenPlatform | null;
}

export type PushRegistrationOutcome =
  | { status: 'registered'; expoPushToken: string }
  /**
   * Every reason is an expected steady state, not an error:
   * - `unsupported-platform` — no push transport exists here at all (see
   *   {@link PushTokenEnvironment.pushTokenPlatform}). Checked FIRST, so this
   *   short-circuits before anything asks the OS about permission.
   * - `permission-not-granted` — the user has not (yet) agreed.
   * - `no-token` — permission is granted but no Expo push token could be minted
   *   (no EAS project id in the build, or the Expo push service was unreachable).
   */
  | { status: 'skipped'; reason: 'unsupported-platform' | 'permission-not-granted' | 'no-token' };

export type PushRetirementOutcome =
  | { status: 'retired'; expoPushToken: string }
  | { status: 'skipped'; reason: 'no-token' };

/**
 * Register this installation's Expo push token for the currently signed-in
 * identity, scoped to the Commons application.
 *
 * The `clientId` scope is what makes targeted delivery possible: the server
 * resolves it to the Commons `Application` (which carries the staff-granted
 * `identity:approval` capability) and delivers approval requests only to that
 * application's registrations — never to every push token the identity owns.
 *
 * Idempotent server-side, so a cold-boot re-registration is free.
 *
 * @throws Whatever `registerPushToken` throws — including the explicit rejection
 *   of a non-Expo token. Callers treat push registration as best-effort and log.
 */
export async function registerInstallationPushToken(
  registry: PushTokenRegistry,
  environment: PushTokenEnvironment,
  options: { clientId: string; deviceId?: string },
): Promise<PushRegistrationOutcome> {
  const platform = environment.pushTokenPlatform();
  if (!platform) {
    return { status: 'skipped', reason: 'unsupported-platform' };
  }

  // Permission first: minting a token without it fails on iOS anyway, and a
  // registration the user never consented to is not one we want to hold.
  if (!(await environment.hasNotificationPermission())) {
    return { status: 'skipped', reason: 'permission-not-granted' };
  }

  const expoPushToken = await environment.getExpoPushToken();
  if (!expoPushToken) {
    return { status: 'skipped', reason: 'no-token' };
  }

  const input: RegisterPushTokenInput = {
    expoPushToken,
    platform,
    clientId: options.clientId,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
  };
  await registry.registerPushToken(input);

  return { status: 'registered', expoPushToken };
}

/**
 * Retire this installation's push token from the identity that currently holds
 * the bearer.
 *
 * MUST be called while that identity's session is still live. The server scopes
 * `DELETE /notifications/push-token` to the authenticated user, so a retirement
 * attempted AFTER the session is gone (or after a different identity has taken
 * over the vault) cannot remove the outgoing identity's row — it would delete
 * the wrong one or nothing at all. That is precisely why the account-deletion
 * sequence retires the token as its FIRST step rather than after signing out.
 *
 * Permission is not re-checked: retiring is strictly a cleanup, and a device
 * whose permission was revoked simply has no token to retire.
 *
 * @throws Whatever `unregisterPushToken` throws; callers treat it as non-fatal.
 */
export async function retireInstallationPushToken(
  registry: PushTokenRegistry,
  environment: Pick<PushTokenEnvironment, 'getExpoPushToken'>,
): Promise<PushRetirementOutcome> {
  const expoPushToken = await environment.getExpoPushToken();
  if (!expoPushToken) {
    return { status: 'skipped', reason: 'no-token' };
  }

  await registry.unregisterPushToken(expoPushToken);
  return { status: 'retired', expoPushToken };
}

/** The shared SDK adapter, bound once so call sites stay declarative. */
const deviceEnvironment: PushTokenEnvironment = {
  hasNotificationPermission,
  getExpoPushToken,
  pushTokenPlatform,
};

/**
 * {@link registerInstallationPushToken} bound to this device and to Commons'
 * registered `clientId`.
 */
export function registerVaultPushToken(
  registry: PushTokenRegistry,
  deviceId?: string,
): Promise<PushRegistrationOutcome> {
  return registerInstallationPushToken(registry, deviceEnvironment, {
    clientId: OXY_CLIENT_ID,
    ...(deviceId ? { deviceId } : {}),
  });
}

/** {@link retireInstallationPushToken} bound to this device. */
export function retireVaultPushToken(registry: PushTokenRegistry): Promise<PushRetirementOutcome> {
  return retireInstallationPushToken(registry, deviceEnvironment);
}
