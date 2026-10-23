import { resolveApplicationSessionLane } from '../oauth/applicationSessionLane';
import { logger as loggerUtil, type OxyServices } from '@oxy.so/core';
import {
  runSessionColdBoot,
  type AuthStateStore,
  type IdentityBinding,
  type SessionMode,
} from '@oxy.so/core/session';
import type { SessionClient } from '@oxy.so/core/session';
import { loadPersistedDeviceCredential } from '../utils/deviceCredential';
import { createPlatformSharedDeviceCredentialStore } from '../session/sharedDeviceCredentialStore';
import { tryCompleteOAuthReturn } from '../utils/oauthReturn';
import { isWebBrowser } from '../utils/isWebBrowser';
import { isNetConnectivityExplicitlyOffline } from '../utils/netConnectivity';
import type { CommitInput } from '../context/oxyContextTypes';

/**
 * Whether the URL carries an OAuth return (`?code=` or `?error=`) for
 * `tryCompleteOAuthReturn` to consume. Reads the address bar only.
 */
function hasOAuthReturnOnUrl(): boolean {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  if (!search) return false;
  const params = new URLSearchParams(search);
  return params.has('code') || params.has('error');
}

/**
 * Whether this origin's own store holds anything a web boot could restore from:
 * a warm access token to plant or a device secret to mint with. A presence
 * check only — nothing read here is used, sent or synced before the
 * classification allows it.
 */
async function hasRestorableState(store: AuthStateStore): Promise<boolean> {
  const persisted = await store.load();
  return Boolean(persisted?.accessToken || persisted?.deviceSecret);
}

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
  /** Provider-owned fresh classifier, also used by explicit action recovery. */
  resolveSessionLane?: () => Promise<'device' | 'oauth'>;
  /** Identity pin work may run only after a fresh device classification. */
  onClassified?: (lane: 'device' | 'oauth') => void | Promise<void>;
  beforeDeviceBoot?: () => Promise<void>;
  afterDeviceBoot?: () => Promise<void>;
  syncDeviceCredentialToHost: () => Promise<void>;
  commitSession: (
    input: CommitInput,
    options: { activate: boolean; oauth?: boolean },
  ) => Promise<void>;
  markAuthResolved: () => void;
  setTokenReady: (ready: boolean) => void;
  /**
   * Show the session saved on this device before any network: the account from
   * its cached profile, auth resolved. Resolves `true` when it did, `false` when
   * the device holds nothing a first paint can use (then the boot runs as a
   * first boot). Never consulted in `sessionMode: 'identity'` or with an OAuth
   * return on the URL.
   */
  paintCachedSession?: () => Promise<boolean>;
  /**
   * The server ended the painted session: the registry now classifies the app
   * as OAuth-only, or the mint answered this holder `invalid_device_secret` /
   * `no_active_session` and no recovery lane restored one. Sign out now.
   */
  onCachedSessionRejected?: () => Promise<void>;
  /**
   * The painted session could not be checked yet (offline, the registry or the
   * mint unreachable). It stays on screen; call `retry` later to ask again.
   */
  onCachedSessionUnconfirmed?: (retry: () => Promise<void>) => void;
}

type ClassificationLane = 'device' | 'oauth';

/** Starts the provider's fresh classification; a rejection is observed, not swallowed. */
function startClassification(opts: RunProviderColdBootOptions): Promise<ClassificationLane> {
  const classification = (async () =>
    opts.resolveSessionLane?.() ??
    resolveApplicationSessionLane(opts.oxyServices, opts.clientId))();
  // Observed so a rejection that lands before it is awaited is not reported as
  // unhandled; every caller still awaits it and sees the rejection.
  classification.catch(() => undefined);
  return classification;
}

/** What the device lanes made of this holder: a session, a verdict against it, or no answer. */
type DeviceRestoreOutcome = 'session' | 'rejected' | 'unreachable';

/**
 * The device lanes of the boot (`runSessionColdBoot`), for a first boot or for
 * the background check of a painted one.
 *
 * A first boot (`painted: false`) is on the critical path: its committed
 * session resolves auth, bounded by {@link SESSION_HANDOFF_DEADLINE_MS}. A
 * painted boot already resolved auth from the cache, so nothing waits on the
 * handoff and the pure-local warm token is skipped: the check needs the mint's
 * verdict, which a still-valid token cannot give.
 */
async function restoreDeviceSession(
  opts: RunProviderColdBootOptions,
  painted: boolean,
): Promise<DeviceRestoreOutcome> {
  const {
    oxyServices,
    authStore,
    sessionMode = 'account',
    identity,
    sessionClient,
    syncDeviceCredentialToHost,
    commitSession,
    markAuthResolved,
  } = opts;

  await opts.beforeDeviceBoot?.();

  // Best-effort connectivity probe up front: an EXPLICIT offline verdict skips
  // the two doomed network steps so routing settles immediately instead of
  // burning the overall deadline on a mint that cannot succeed. Any ambiguity
  // resolves to "online" — the network steps still run.
  const offline = await detectOfflineHint();

  let outcome: DeviceRestoreOutcome = 'unreachable';
  let holderRejected = false;
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
    requireServerVerdict: painted,
    onHolderRejected: () => {
      holderRejected = true;
    },
    onStepDeadline: (stepId) => {
      loggerUtil.warn(
        `Cold-boot step "${stepId}" exceeded the ${COLD_BOOT_OVERALL_DEADLINE_MS}ms overall deadline — abandoned; routing proceeds signed-out`,
        { component: 'runProviderColdBoot', method: 'onStepDeadline' },
      );
    },
    onSession: async (session) => {
      outcome = 'session';
      // Mint already persisted `{deviceId, deviceSecret}` to the store; sync the
      // in-memory SessionClient host so sockets + tab-focus re-mint can use it.
      await syncDeviceCredentialToHost();
      const handoff = commitSession(
        {
          sessionId: session.sessionId,
          accessToken: session.accessToken,
          userId: session.userId,
          deviceState: session.state,
        },
        { activate: false },
      );
      if (painted) {
        // The account is already on screen; the commit refreshes its profile.
        await handoff;
        return;
      }
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
      outcome = holderRejected ? 'rejected' : 'unreachable';
      await syncDeviceCredentialToHost();
      // A painted session is the caller's to end or keep (see verifyCachedSession).
      if (painted) return;
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
  await opts.afterDeviceBoot?.();
  return outcome;
}

/**
 * The background check of a painted session: the registry's classification and
 * a mint with this holder's own credential (whose commit refreshes the profile).
 * Each is asked until the server answers it. A verdict against the session
 * signs out at that moment; no answer keeps the cached session on screen and
 * hands the caller a retry.
 */
async function verifyCachedSession(
  opts: RunProviderColdBootOptions,
  verified: { lane: boolean; session: boolean },
  classification: Promise<ClassificationLane>,
): Promise<void> {
  if (!verified.lane) {
    let lane: ClassificationLane | null = null;
    try {
      lane = await classification;
    } catch {
      // The registry could not be asked (offline, timeout, 5xx). That is no
      // verdict on this app: the cached `device` classification stands until it
      // answers.
    }
    if (lane === 'oauth') {
      await opts.onCachedSessionRejected?.();
      return;
    }
    verified.lane = lane === 'device';
  }
  if (!verified.session) {
    const outcome = await restoreDeviceSession(opts, true);
    if (outcome === 'rejected') {
      await opts.onCachedSessionRejected?.();
      return;
    }
    verified.session = outcome === 'session';
  }
  if (!verified.lane || !verified.session) {
    opts.onCachedSessionUnconfirmed?.(() =>
      verifyCachedSession(
        opts,
        verified,
        verified.lane ? Promise.resolve('device') : startClassification(opts),
      ),
    );
  }
}

/**
 * Device-first cold boot for `@oxy.so/services` providers.
 *
 * A returning session saved on this device (account mode, the app last
 * classified `device`, its profile cached) paints first, with no network, and
 * is then checked in the background — see `paintCachedSession`. Otherwise, a
 * first boot:
 *
 * Ordered pipeline:
 * 1. Complete an OAuth authorization-code return already on the URL (web)
 * 2. `runSessionColdBoot` — device-secret mint (+ the native Commons-proof lane,
 *    or the primary-identity-key lane in `sessionMode: 'identity'`)
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
    commitSession,
    markAuthResolved,
    setTokenReady,
  } = opts;

  const identityBound = sessionMode === 'identity';

  setTokenReady(false);

  try {
    // Classification precedes every USE of a local secret, the shared credential
    // and the identity key. Unavailable registry metadata fails closed on a first
    // boot, including offline. It starts now, before anything else, so its round
    // trip overlaps the local work below.
    const classification = startClassification(opts);

    // A returning session saved on this device paints at once from the cache:
    // the account, its cached content, auth resolved, no network on the way.
    // The classification and the session are then checked in the background,
    // and a verdict against either signs out at that moment. Identity-bound
    // clients and OAuth returns keep the path below.
    const freshLaunch = !identityBound && !hasOAuthReturnOnUrl();
    if (freshLaunch && (await opts.paintCachedSession?.())) {
      await verifyCachedSession(opts, { lane: false, session: false }, classification);
      return;
    }

    // The verdict decides HOW a session is restored, never WHETHER there is one.
    // A web origin with nothing to restore and no OAuth return on the URL ends
    // signed out on either lane, so routing need not wait a network round trip
    // for an answer that cannot change the outcome. The classification still
    // completes below and still gates every later sign-in
    // (`ensureDeviceSessionLane` shares this same in-flight lookup).
    if (freshLaunch && isWebBrowser()) {
      if (!(await hasRestorableState(authStore))) {
        markAuthResolved();
        const lane = await classification;
        await opts.onClassified?.(lane);
        if (lane === 'oauth') setTokenReady(true);
        return;
      }
    }

    const lane = await classification;
    await opts.onClassified?.(lane);
    if (identityBound && lane !== 'device') return;
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
          commitSession: (input) => commitSession(input, { activate: true, oauth: true }),
        });
    if (oauthCompleted) {
      setTokenReady(true);
      markAuthResolved();
      return;
    }

    if (lane === 'oauth') {
      setTokenReady(true);
      return;
    }

    await restoreDeviceSession(opts, false);
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
