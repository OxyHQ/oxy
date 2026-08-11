import {
  logger as loggerUtil,
  runSessionColdBoot,
  type AuthStateStore,
  type IdentityBinding,
  type OxyServices,
  type SessionMode,
} from '@oxyhq/core';
import type { SessionClient } from '@oxyhq/core';
import { loadPersistedDeviceCredential } from '../utils/deviceCredential';
import { createPlatformSharedDeviceCredentialStore } from '../session/sharedDeviceCredentialStore';
import { tryCompleteOAuthReturn } from '../utils/oauthReturn';
import { isWebBrowser } from '../utils/isWebBrowser';
import { isNetConnectivityExplicitlyOffline } from '../utils/netConnectivity';
import type { CommitInput } from '../context/oxyContextTypes';

/** How long the cold boot waits for the post-boot SessionClient handoff (ms). */
export const SESSION_HANDOFF_DEADLINE_MS = 6000;

/**
 * HARD overall deadline (ms) for the whole `runSessionColdBoot` step chain.
 *
 * Bounds time-to-route: routing gates on `isAuthResolved`, which resolves when
 * the cold boot finishes, so a network step that never settles (a black-hole
 * network that neither connects nor rejects) would otherwise hang routing
 * indefinitely. 12s comfortably exceeds the healthy worst case of the
 * sequential, single-attempt (`retry:false`), 5s-capped network steps, so it is
 * INERT on healthy loads and only trips on a pathological network. Offline
 * devices short-circuit far sooner via the connectivity hint below.
 */
export const COLD_BOOT_OVERALL_DEADLINE_MS = 12_000;

/**
 * Timeout (ms) for the best-effort native connectivity probe. Kept tight so the
 * probe never itself adds meaningful latency to a healthy boot — an unknown
 * result within this window is treated as "online".
 */
const OFFLINE_PROBE_TIMEOUT_MS = 500;

/**
 * Best-effort, FAST connectivity probe run once before the cold boot.
 *
 * Returns `true` ONLY on an EXPLICIT disconnected verdict; every ambiguous
 * outcome (probe timeout, unknown/`null` state, NetInfo unavailable, a thrown
 * error) resolves to `false` (assume online) so a flaky probe can never falsely
 * skip a real sign-in. Never rejects. On web it reads `navigator.onLine`; on
 * native it races `NetInfo.fetch()` against {@link OFFLINE_PROBE_TIMEOUT_MS},
 * mirroring the existing NetInfo dynamic-import pattern in `OxyProvider`.
 */
async function detectOfflineHint(): Promise<boolean> {
  try {
    if (isWebBrowser()) {
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      // Only an explicit `false` is an offline verdict; `undefined` ⇒ assume online.
      return online === false;
    }
    const NetInfo = await import('@react-native-community/netinfo');
    const state = await Promise.race([
      NetInfo.default.fetch(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), OFFLINE_PROBE_TIMEOUT_MS);
      }),
    ]);
    // `null` ⇒ the probe timed out (unknown → assume online). Only an explicit
    // disconnected / unreachable verdict disables the network steps.
    return isNetConnectivityExplicitlyOffline(state);
  } catch {
    // NetInfo missing / probe threw — never block sign-in on a probe failure.
    return false;
  }
}

export interface RunProviderColdBootOptions {
  oxyServices: OxyServices;
  authStore: AuthStateStore;
  clientId?: string;
  authRedirectUri?: string;
  /**
   * Who owns the session this boot resolves. `'account'` (the default) is the
   * device's active account — every ordinary Oxy app. `'identity'` binds the
   * boot to the owner of this device's PRIMARY identity key and REQUIRES
   * {@link identity}; it also disables the web OAuth return leg below, which
   * commits whatever account the IdP hands back.
   */
  sessionMode?: SessionMode;
  /** The identity binding required by `sessionMode: 'identity'`. */
  identity?: IdentityBinding;
  sessionClient: SessionClient;
  syncDeviceCredentialToHost: () => Promise<void>;
  commitSession: (input: CommitInput, options: { activate: boolean }) => Promise<void>;
  markAuthResolved: () => void;
  setTokenReady: (ready: boolean) => void;
}

/**
 * Device-first cold boot for `@oxyhq/services` providers.
 *
 * Ordered pipeline:
 * 1. Complete an OAuth authorization-code return already on the URL (web)
 * 2. `runSessionColdBoot` — device-secret mint (+ native shared-key, or the
 *    primary-identity-key lane in `sessionMode: 'identity'`)
 *
 * Step 1 is ACCOUNT-MODE ONLY: it commits whichever account the IdP resolves,
 * which for an identity-bound client is somebody else's account by construction.
 * In `'identity'` mode the boot is exactly step 2.
 *
 * The boot NEVER navigates the top-level window. There is no automatic
 * `prompt=none` bounce to the IdP: a web origin with no local device credential
 * resolves SIGNED OUT and waits for the user's next explicit "Continue with
 * Oxy", which opens a popup from a real gesture (#691 phase 7b). Step 1 is not a
 * navigation — it only consumes a code that is already in the address bar.
 */
export async function runProviderColdBoot(opts: RunProviderColdBootOptions): Promise<void> {
  const {
    oxyServices,
    authStore,
    clientId,
    authRedirectUri,
    sessionMode = 'account',
    identity,
    sessionClient,
    syncDeviceCredentialToHost,
    commitSession,
    markAuthResolved,
    setTokenReady,
  } = opts;

  const identityBound = sessionMode === 'identity';

  setTokenReady(false);

  try {
    // The redirect transport's RETURN leg. An app reaches it whenever the browser
    // BLOCKED the sign-in popup and `startWebOAuthSignIn` fell back to a
    // full-page redirect (`popup-blocked` / `popup-navigation-failed`), so it is
    // load-bearing even though nothing here ever starts a redirect. It consumes a
    // code (or a stale OAuth `error`) already in the address bar and rewrites the
    // URL via `history.replaceState`; it never begins a navigation.
    const oauthCompleted = identityBound
      ? false
      : await tryCompleteOAuthReturn({
          oxyServices,
          clientId,
          authRedirectUri,
          commitSession: (input) => commitSession(input, { activate: true }),
        });
    if (oauthCompleted) {
      setTokenReady(true);
      markAuthResolved();
      return;
    }

    // Best-effort connectivity probe up front: an EXPLICIT offline verdict skips
    // the two doomed network steps so routing settles immediately instead of
    // burning the overall deadline on a mint that cannot succeed. Any ambiguity
    // resolves to "online" — the network steps still run.
    const offline = await detectOfflineHint();

    await runSessionColdBoot({
      oxy: oxyServices,
      store: authStore,
      platform: { isWeb: isWebBrowser(), isNative: !isWebBrowser() },
      sessionMode,
      identity,
      // The device-wide shared credential slot, enabling the `shared-device-adopt`
      // lane: a newly installed official app joins this device's existing session
      // instead of falling back to signing a challenge with the Commons identity
      // key. `null` on web, where each origin is its own device by design; the
      // core lane is also skipped outright in `sessionMode: 'identity'`.
      sharedDeviceCredential: createPlatformSharedDeviceCredentialStore() ?? undefined,
      overallDeadlineMs: COLD_BOOT_OVERALL_DEADLINE_MS,
      isOffline: () => offline,
      onStepDeadline: (stepId) => {
        loggerUtil.warn(
          `Cold-boot step "${stepId}" exceeded the ${COLD_BOOT_OVERALL_DEADLINE_MS}ms overall deadline — abandoned; routing proceeds signed-out`,
          { component: 'runProviderColdBoot', method: 'onStepDeadline' },
        );
      },
      onSession: async (session) => {
        // Mint already persisted `{deviceId, deviceSecret}` to the store; sync the
        // in-memory SessionClient host so sockets + tab-focus re-mint can use it.
        await syncDeviceCredentialToHost();
        const handoff = commitSession(
          {
            sessionId: session.sessionId,
            accessToken: session.accessToken,
            userId: session.userId,
          },
          { activate: false },
        );
        let handoffDeadlineId: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          handoff,
          new Promise<void>((resolve) => {
            handoffDeadlineId = setTimeout(resolve, SESSION_HANDOFF_DEADLINE_MS);
          }),
        ]).finally(() => {
          if (handoffDeadlineId !== undefined) {
            clearTimeout(handoffDeadlineId);
          }
        });
        markAuthResolved();
      },
      onSignedOut: async () => {
        await syncDeviceCredentialToHost();
        const cred = await loadPersistedDeviceCredential(authStore);
        if (cred) {
          try {
            await sessionClient.start();
          } catch (socketError) {
            if (__DEV__) {
              loggerUtil.debug(
                'Device socket start failed (non-fatal)',
                { component: 'runProviderColdBoot' },
                socketError,
              );
            }
          }
        }
        markAuthResolved();
      },
      onStepError: (id, error) => {
        if (__DEV__) {
          loggerUtil.debug(
            `Cold-boot step "${id}" errored (non-fatal, falling through)`,
            { component: 'runProviderColdBoot' },
            error,
          );
        }
      },
    });
  } catch (error) {
    if (__DEV__) {
      loggerUtil.error(
        'Cold boot error',
        error instanceof Error ? error : new Error(String(error)),
        { component: 'runProviderColdBoot' },
      );
    }
  } finally {
    markAuthResolved();
  }
}

