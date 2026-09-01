/**
 * Lightweight `@oxyhq/services` stub for unit tests in the inbox package.
 *
 * `useOxy()` is implemented with `useSyncExternalStore`, so a `__setOxyState()`
 * call made outside React is reflected in any mounted consumer's next render.
 * Only the members the code under test reads are modelled.
 *
 * The device-notification adapter is stubbed here too: it is the SDK's
 * `expo-notifications` surface (`packages/services/src/notifications/`), whose
 * own behaviour is covered upstream. Stubbing it at the package boundary is what
 * keeps a test of Inbox's push orchestration free of any native module while
 * still exercising the real wiring — including that Inbox reaches for the SDK's
 * adapter rather than a copy of its own.
 */

import { useSyncExternalStore } from 'react';
import type { PushTokenPlatform } from '@oxyhq/core';

/** The `@oxyhq/core` push surface, plus the bearer probe teardown consults. */
export interface MockOxyServices {
  registerPushToken: jest.Mock;
  unregisterPushToken: jest.Mock;
  getAccessToken: jest.Mock;
}

interface MockSessionClient {
  getState: () => { deviceId: string } | null;
}

interface MockOxyState {
  user: { id?: string; username?: string } | null;
  isAuthenticated: boolean;
  /** The SDK's "a usable bearer is planted" verdict — the private-API gate. */
  canUsePrivateApi: boolean;
  /** Device-session client; `null` when no device state has been resolved. */
  sessionClient: MockSessionClient | null;
  oxyServices: MockOxyServices;
}

export function makeMockOxyServices(): MockOxyServices {
  return {
    registerPushToken: jest.fn(async () => undefined),
    unregisterPushToken: jest.fn(async () => undefined),
    getAccessToken: jest.fn(() => 'access-token'),
  };
}

function makeDefaultState(): MockOxyState {
  return {
    user: null,
    isAuthenticated: false,
    canUsePrivateApi: false,
    sessionClient: null,
    oxyServices: makeMockOxyServices(),
  };
}

let state: MockOxyState = makeDefaultState();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function __setOxyState(next: Partial<MockOxyState>): void {
  state = { ...state, ...next };
  emit();
}

export function __resetOxyState(): void {
  state = makeDefaultState();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MockOxyState {
  return state;
}

export const useOxy = (): MockOxyState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

// ---------------------------------------------------------------------------
// Device notifications — the SDK's `expo-notifications` adapter
// ---------------------------------------------------------------------------

/**
 * A well-formed Expo push token, the only shape the push service delivers to.
 *
 * Shared with the tests so an assertion about "what left the client" compares
 * against the same value the adapter handed over.
 */
export const MOCK_EXPO_PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

/** The platform tag the push registry stores this installation under. */
export const pushTokenPlatform = jest.fn<PushTokenPlatform | null, []>(() => 'ios');

/** The OS permission, prompting at most once per installation. */
export const requestNotificationPermission = jest.fn<Promise<boolean>, []>(async () => true);

/** This installation's Expo push token, or null when one cannot be minted. */
export const getExpoPushToken = jest.fn<Promise<string | null>, []>(
  async () => MOCK_EXPO_PUSH_TOKEN,
);

/** Restore the "supported platform, permission granted, token available" default. */
export function __resetNotificationAdapter(): void {
  pushTokenPlatform.mockReset().mockReturnValue('ios');
  requestNotificationPermission.mockReset().mockResolvedValue(true);
  getExpoPushToken.mockReset().mockResolvedValue(MOCK_EXPO_PUSH_TOKEN);
}
