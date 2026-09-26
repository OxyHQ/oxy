import type { User } from '@oxy.so/core';
import { logger as loggerUtil } from '@oxy.so/core';
import { isUnauthorizedStatus } from './oxyContextHelpers';

const LOG_CONTEXT = { component: 'OxyContext', method: 'commitSession' } as const;

export interface CommitDeviceSetAndResolveDeps {
  /**
   * Whether this commit is a deliberate sign-in on THIS device (activates the
   * account and BLOCKS on the device-set reconcile before resolving) vs. a
   * cold-boot restore (resolves auth from the profile fetch FIRST, then
   * reconciles the device set in the background).
   */
  activate: boolean;
  /** Cold boot already carries authoritative device state from the mint. */
  hasDeviceState?: boolean;
  /** The committing account id (only used by `registerAndActivate`). */
  userId?: string;
  /** Minimal user carried by the commit input; used if the profile fetch fails. */
  fallbackUser: User | null;
  /** Deliberate sign-in: register + activate the account in the device set. */
  registerAndActivate: (userId?: string) => Promise<void>;
  /** Cold boot: ensure membership only; the server's `activeAccountId` wins. */
  addCurrentAccount: () => Promise<void>;
  /** Start the device-scoped socket. */
  startSocket: () => Promise<void>;
  /** Project the server-authoritative device state onto local sessions. */
  syncFromClient: () => Promise<void>;
  /** Hydrate the full profile (the commit input carries only minimal data). */
  getCurrentUser: () => Promise<User | null>;
  loginSuccess: (user: User) => void;
  onAuthStateChange?: (user: User | null) => void;
  markAuthResolved: () => void;
}

/**
 * Device-set registration + full-user hydration + auth-resolution gate flip.
 *
 * On a deliberate sign-in (`activate: true`) the device-set reconcile is awaited
 * BEFORE hydrating and resolving — unchanged legacy ordering. On a cold boot
 * (`activate: false`) auth resolves from the profile fetch FIRST so the app can
 * paint an authenticated shell without waiting on device-set registration, the
 * socket connect, and the authoritative sessions projection — those reconcile in
 * a DETACHED background task a moment later.
 */
export async function commitDeviceSetAndResolve(
  deps: CommitDeviceSetAndResolveDeps,
): Promise<void> {
  const {
    activate,
    hasDeviceState = false,
    userId,
    fallbackUser,
    registerAndActivate,
    addCurrentAccount,
    startSocket,
    syncFromClient,
    getCurrentUser,
    loginSuccess,
    onAuthStateChange,
    markAuthResolved,
  } = deps;

  // Register into the device set, start the socket, then project server truth. A
  // deliberate sign-in ACTIVATES the account (`registerAndActivate`); the cold
  // boot only ensures membership and lets the server's own `activeAccountId` win
  // (`addCurrentAccount`).
  const reconcileDeviceSet = async (): Promise<void> => {
    if (activate) {
      await registerAndActivate(userId);
    } else if (!hasDeviceState) {
      await addCurrentAccount();
    }
    await startSocket();
    await syncFromClient();
  };

  const logReconcileError = (registrationError: unknown): void => {
    // A 401 here is the EXPECTED signed-out edge: the bearer was stale/cleared, so
    // the device-set registration (`POST /session/device/add`) cannot carry auth.
    // This is not a failure — the cold boot re-registers on the next load once a
    // valid session is minted. Log at debug; warn only on genuine unexpected
    // failures (network, 5xx, malformed).
    if (isUnauthorizedStatus(registrationError)) {
      loggerUtil.debug('commitSession: device-set registration skipped (signed out)', LOG_CONTEXT, registrationError);
      return;
    }
    loggerUtil.warn('commitSession: device-set registration failed', LOG_CONTEXT, registrationError);
  };

  // Hydrate the full user then flip the auth-resolution gate. Falls back to the
  // minimal commit-input shape if the profile fetch fails — never leaves auth
  // unresolved.
  const hydrateAndResolve = async (): Promise<void> => {
    let fullUser: User | null = null;
    try {
      fullUser = await getCurrentUser();
    } catch (profileError) {
      if (__DEV__) {
        loggerUtil.debug('Failed to fetch full user on commit; using minimal fallback', LOG_CONTEXT, profileError);
      }
      fullUser = fallbackUser;
    }
    if (!fullUser) {
      fullUser = fallbackUser;
    }
    if (fullUser) {
      loginSuccess(fullUser);
      onAuthStateChange?.(fullUser);
    }
    markAuthResolved();
  };

  if (activate) {
    // Deliberate sign-in: block on the device-set reconcile (unchanged ordering)
    // before hydrating + resolving, so the account is fully registered/active.
    try {
      await reconcileDeviceSet();
    } catch (registrationError) {
      logReconcileError(registrationError);
    }
    await hydrateAndResolve();
    return;
  }

  // Cold boot: resolve auth from the profile fetch FIRST; reconcile the device
  // set (membership when the mint did not already return it, socket + sessions
  // projection) in a DETACHED background
  // task so first paint is not blocked behind those round-trips.
  await hydrateAndResolve();
  void reconcileDeviceSet().catch(logReconcileError);
}
