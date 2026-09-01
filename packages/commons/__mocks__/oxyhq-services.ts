/**
 * Lightweight `@oxyhq/services` stub for unit tests in the Commons package.
 *
 * `useOxy()` is implemented with `useSyncExternalStore` so that calls to
 * `__setOxyState({...})` outside of React are immediately reflected in any
 * mounted consumer's next render. `useOnlineStatus()` is similarly controllable
 * via `__setOnlineStatus(...)`, and the shared device-notifications adapter via
 * the `__…Notification…` helpers at the bottom of this file.
 */

import { createElement, useEffect, useSyncExternalStore, type ReactElement } from 'react';
import type { PushTokenPlatform } from '@oxyhq/core';

interface MockOxyServices {
  updateProfile?: jest.Mock;
  getCommonsApprovalInfo?: jest.Mock;
  markCommonsApprovalOpened?: jest.Mock;
  approveCommonsSignIn?: jest.Mock;
  denyCommonsSignIn?: jest.Mock;
  registerPushToken?: jest.Mock;
  unregisterPushToken?: jest.Mock;
  getPublicKey?: jest.Mock;
  getPublicCard?: jest.Mock;
  getReputationBalance?: jest.Mock;
  getMyReputationBalance?: jest.Mock;
  getReputationTransactions?: jest.Mock;
  getFileDownloadUrl?: jest.Mock;
  getCurrentUserId?: jest.Mock;
  getMyIdPayload?: jest.Mock;
  buildAttestQrPayload?: jest.Mock;
  submitRealLifeAttestation?: jest.Mock;
  getValidatorInbox?: jest.Mock;
  submitValidationVote?: jest.Mock;
  denyValidation?: jest.Mock;
  getMyPersonhood?: jest.Mock;
  getPersonhood?: jest.Mock;
  vouchForPerson?: jest.Mock;
  withdrawVouch?: jest.Mock;
  listMyCredentials?: jest.Mock;
  listCredentials?: jest.Mock;
  verifyCredential?: jest.Mock;
  issueCredential?: jest.Mock;
  revokeCredential?: jest.Mock;
  getMyNode?: jest.Mock;
  registerNode?: jest.Mock;
  provisionManagedVault?: jest.Mock;
  removeMyNode?: jest.Mock;
  notifyNodeIngest?: jest.Mock;
}

interface MockSessionClient {
  getState: () => { deviceId: string } | null;
}

interface MockOxyState {
  user: {
    id?: string;
    username?: string;
    /** Structured name; `displayName` is optional, exactly as the SDK types it. */
    name?: { displayName?: string };
    languages?: string[];
    avatar?: string | null;
  } | null;
  isAuthenticated: boolean;
  isAuthResolved: boolean;
  /**
   * The SDK's "a usable bearer is planted" verdict — the gate consumer apps use
   * before any private (bearer-authed) call. Defaults to `false`; tests that
   * exercise a private-API path set it explicitly.
   */
  canUsePrivateApi: boolean;
  /** Device-session client; `null` when no device state has been resolved. */
  sessionClient: MockSessionClient | null;
  isLoading: boolean;
  /** The active UI locale, as the real SDK derives it. */
  currentLanguage: string;
  /** The ordered account locales (primary first), or the single guest locale. */
  currentLanguages: string[];
  oxyServices: MockOxyServices | null;
  /** The SDK key sign-in the silent/biometric sign-in hooks delegate to. */
  signIn: jest.Mock;
}

function makeDefaultState(): MockOxyState {
  return {
    user: null,
    isAuthenticated: false,
    // Defaults to `true`: these tests assert the settled onboarding status,
    // i.e. after the SDK's device-first cold boot has concluded. Set it to
    // `false` explicitly to exercise the still-resolving ("checking") window.
    isAuthResolved: true,
    canUsePrivateApi: false,
    sessionClient: null,
    isLoading: false,
    currentLanguage: 'en-US',
    currentLanguages: [],
    oxyServices: { updateProfile: jest.fn(async () => undefined) },
    signIn: jest.fn(async () => ({ id: 'mock-user' })),
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

// Guest override writer: stores a single locale and makes it the active locale.
const setLanguage = jest.fn(async (locale: string): Promise<void> => {
  __setOxyState({ currentLanguage: locale, currentLanguages: [locale] });
});

// Account writer: `{ languages }` sets the ordered account locales; the derived
// `currentLanguage` then follows `languages[0]`.
const updateProfileMutateAsync = jest.fn(
  async (updates: { languages?: string[] }): Promise<void> => {
    const languages = updates.languages;
    if (languages && languages.length > 0) {
      __setOxyState({ currentLanguage: languages[0], currentLanguages: languages });
    }
  },
);

export function __resetOxyState(): void {
  state = makeDefaultState();
  setLanguage.mockClear();
  updateProfileMutateAsync.mockClear();
  emit();
  oxyEventHandlers.clear();
}

/** Exposes the locale writer spies for call assertions. */
export function __getLanguageMocks(): {
  setLanguage: jest.Mock;
  updateProfileMutateAsync: jest.Mock;
} {
  return { setLanguage, updateProfileMutateAsync };
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

export const useOxy = (): MockOxyState & { setLanguage: jest.Mock } => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, setLanguage };
};

export function useUpdateProfile(): { mutateAsync: jest.Mock; isPending: boolean } {
  return { mutateAsync: updateProfileMutateAsync, isPending: false };
}

/**
 * Auth store stub — only the members consumer code touches in tests
 * (`setState` for surfacing an auth error, `getState` for auth-state polling).
 */
export const useAuthStore = {
  setState: jest.fn(),
  getState: jest.fn(() => ({ isAuthenticated: false })),
};

/**
 * Error funnel stub — mirrors the real signature: it invokes the caller's
 * `setAuthError` with the default message so a rejected flow still surfaces a
 * message, without pulling in the real toast/logging machinery.
 */
export const handleAuthError = jest.fn(
  (
    _error: unknown,
    opts?: { defaultMessage?: string; setAuthError?: (message: string) => void },
  ): void => {
    opts?.setAuthError?.(opts.defaultMessage ?? 'Authentication error');
  },
);

/** Hydration hook — a no-op in tests. */
export const useCurrentUser = (): { data: undefined } => ({ data: undefined });

/** Brand mark — a marker element; the real SVG needs the native renderer. */
export const LogoIcon = (): ReactElement =>
  createElement('span', { 'data-testid': 'oxy-logo-icon' });

/* -------------------------------------------------------------------------- */
/*  Online status                                                             */
/* -------------------------------------------------------------------------- */

let online = true;
const onlineListeners = new Set<() => void>();

export function __setOnlineStatus(next: boolean): void {
  online = next;
  for (const fn of onlineListeners) fn();
}

export const useOnlineStatus = (): boolean =>
  useSyncExternalStore(
    (listener: () => void) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    () => online,
    () => online,
  );

/* -------------------------------------------------------------------------- */
/*  Server-pushed events (useOxyEvent)                                       */
/* -------------------------------------------------------------------------- */

type OxyEventHandler = (payload: unknown) => void;
const oxyEventHandlers = new Map<string, Set<OxyEventHandler>>();

export function useOxyEvent(event: string, handler: OxyEventHandler): void {
  useEffect(() => {
    let set = oxyEventHandlers.get(event);
    if (!set) {
      set = new Set();
      oxyEventHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, [event, handler]);
}

/** Test helper: fire a fake server-pushed event at all registered handlers. */
export function __emitOxyEvent(event: string, payload: unknown): void {
  for (const handler of [...(oxyEventHandlers.get(event) ?? [])]) handler(payload);
}

/* -------------------------------------------------------------------------- */
/*  Device notifications — the shared expo-notifications adapter              */
/* -------------------------------------------------------------------------- */

/**
 * `@oxyhq/services` owns the ONE `expo-notifications` adapter in the ecosystem,
 * and its behaviour — the native-only guard, the EXPO-token rule, the one-shot
 * foreground latch, the permission short-circuits — is tested in that package.
 *
 * Stubbing it here is therefore not a convenience: it is what keeps Commons'
 * tests about COMMONS policy (which payload earns a banner, what a tap may do,
 * when a registration may leave the device) instead of re-testing the SDK.
 *
 * The defaults describe a granted Android install — the state every Commons push
 * path is written for. A test that needs another state sets it explicitly.
 */
export type ForegroundPresentation = 'show' | 'suppress';

/** The Expo push token shape the adapter mints; shared so assertions match. */
export const __EXPO_PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

export const pushTokenPlatform = jest.fn<PushTokenPlatform | null, []>(() => 'android');

export const hasNotificationPermission = jest.fn<Promise<boolean>, []>(async () => true);

export const requestNotificationPermission = jest.fn<Promise<boolean>, []>(async () => true);

export const getExpoPushToken = jest.fn<Promise<string | null>, []>(
  async () => __EXPO_PUSH_TOKEN,
);

export const takeLaunchNotificationData = jest.fn<Promise<unknown>, []>(async () => null);

/**
 * Android channel creation. Recorded so a test can pin that the vault creates
 * the channel the API sends on BEFORE it registers a token — Android 8+ drops a
 * notification whose channel does not exist, with no error on either side.
 */
export const ensureNotificationChannel = jest.fn<
  Promise<boolean>,
  [{ id: string; name: string; description?: string; importance?: 'default' | 'high' }]
>(async () => true);

/** The decision function the foreground install was last handed, if any. */
let foregroundDecision: ((data: unknown) => ForegroundPresentation) | null = null;

export const installForegroundNotificationHandler = jest.fn<
  Promise<boolean>,
  [(data: unknown) => ForegroundPresentation]
>(async (decide) => {
  foregroundDecision = decide;
  return true;
});

/**
 * The presentation policy the app handed the adapter.
 *
 * Throws rather than returning null when nothing was installed: a test that
 * reaches for the policy has already asserted the install happened, and a silent
 * null would turn that into a confusing "cannot read property of null".
 */
export function __getForegroundDecision(): (data: unknown) => ForegroundPresentation {
  if (!foregroundDecision) {
    throw new Error('no foreground notification decision was installed');
  }
  return foregroundDecision;
}

/** The handle every `subscribeToNotificationResponses` call resolves. */
export const __notificationUnsubscribe = jest.fn<void, []>();

/** The tap listener the app last subscribed with, if any. */
let notificationResponseListener: ((data: unknown) => void) | null = null;

export const subscribeToNotificationResponses = jest.fn<
  Promise<() => void>,
  [(data: unknown) => void]
>(async (listener) => {
  notificationResponseListener = listener;
  return __notificationUnsubscribe;
});

/** Test helper: deliver a notification TAP to the subscribed listener. */
export function __emitNotificationResponse(data: unknown): void {
  if (!notificationResponseListener) {
    throw new Error('no notification response listener is subscribed');
  }
  notificationResponseListener(data);
}

/** Whether a tap listener is currently subscribed (for await-the-subscribe waits). */
export function __hasNotificationResponseListener(): boolean {
  return notificationResponseListener !== null;
}

export function __resetNotificationAdapter(): void {
  foregroundDecision = null;
  notificationResponseListener = null;
  pushTokenPlatform.mockReset().mockReturnValue('android');
  hasNotificationPermission.mockReset().mockResolvedValue(true);
  requestNotificationPermission.mockReset().mockResolvedValue(true);
  getExpoPushToken.mockReset().mockResolvedValue(__EXPO_PUSH_TOKEN);
  takeLaunchNotificationData.mockReset().mockResolvedValue(null);
  __notificationUnsubscribe.mockReset();
  ensureNotificationChannel.mockReset().mockResolvedValue(true);
  installForegroundNotificationHandler.mockReset().mockImplementation(async (decide) => {
    foregroundDecision = decide;
    return true;
  });
  subscribeToNotificationResponses.mockReset().mockImplementation(async (listener) => {
    notificationResponseListener = listener;
    return __notificationUnsubscribe;
  });
}
