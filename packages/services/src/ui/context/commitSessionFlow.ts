import type { User } from '@oxyhq/core';
import { logger as loggerUtil } from '@oxyhq/core';
import { allowsAutomaticIdpRedirect } from '../oauth/legacyRedirectLanes';
import type { WebAuthMode } from '../oauth/types';
import { isWebBrowser } from '../utils/isWebBrowser';
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
    } else {
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
  // set (membership + socket + sessions projection) in a DETACHED background
  // task so first paint is not blocked behind those round-trips.
  await hydrateAndResolve();
  void reconcileDeviceSet().catch(logReconcileError);
}

export interface MaybeSyncHubAfterCommitDeps {
  /** Deliberate sign-in (`true`) vs. a cold-boot / background commit (`false`). */
  activate: boolean;
  /** Per-commit opt-in — `commitSession`'s `options.hubSync`. */
  hubSyncRequested: boolean;
  /** Provider-level opt-out — `OxyProviderProps.hubSync`. */
  hubSyncEnabled: boolean;
  /**
   * The provider's web sign-in transport — `OxyProviderProps.webAuthMode`.
   * A first-class input: `'popup'` forbids the redirect outright.
   */
  webAuthMode: WebAuthMode;
  /**
   * Starts the full-page hop to `auth.oxy.so/sync`; resolves `true` when the
   * navigation was actually started.
   */
  syncHub: () => Promise<boolean>;
}

/**
 * Post-sign-in hub sync: plant this device's credential on the IdP hub so OTHER
 * official origins can silently restore a session on their next cold boot.
 *
 * The tail of the ONE commit funnel (`commitSession`), extracted so every gate
 * on this legacy lane lives — and is tested — in one place. Returns whether the
 * full-page redirect was started; a failure is non-fatal and never propagates
 * (the sign-in itself already succeeded).
 *
 * Four gates, all of which must pass:
 * 1. `activate` — only a deliberate sign-in syncs; a cold-boot restore never does.
 * 2. `hubSyncRequested` — the in-place lanes (account switch, popup OAuth) opt out.
 * 3. `hubSyncEnabled` — the provider-level `hubSync` prop.
 * 4. `allowsAutomaticIdpRedirect(webAuthMode)` — hub sync REPLACES the document
 *    with `auth.oxy.so`, so `webAuthMode: 'popup'` forbids it: a redirect that
 *    bounces the tab defeats the entire point of the mode, no matter which
 *    commit path produced the session (issue #691, "Cold boot and cross-domain
 *    behavior"). Redirect mode — the default and the compatibility path — is
 *    unchanged, and this whole function disappears with it in phase 7b.
 */
export async function maybeSyncHubAfterCommit(
  deps: MaybeSyncHubAfterCommitDeps,
): Promise<boolean> {
  const { activate, hubSyncRequested, hubSyncEnabled, webAuthMode, syncHub } = deps;

  if (!activate || !hubSyncRequested || !hubSyncEnabled) return false;
  if (!allowsAutomaticIdpRedirect(webAuthMode)) return false;
  if (!isWebBrowser()) return false;

  try {
    return await syncHub();
  } catch (hubError) {
    if (__DEV__) {
      loggerUtil.debug('Hub sync after sign-in failed (non-fatal)', LOG_CONTEXT, hubError);
    }
    return false;
  }
}
