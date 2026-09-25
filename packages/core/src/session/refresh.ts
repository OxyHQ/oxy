/**
 * Unified token refresh — THE single access-token re-mint for web + native.
 *
 * The access token is short-lived; there is no refresh token. To keep a session
 * alive past the access token's TTL the client re-mints via the zero-cookie
 * device transport:
 *
 *  - `refreshPersistedSession` — arm 1 mints a fresh access token from the
 *    persisted `deviceId` + `deviceSecret` (`POST /session/device/token`),
 *    planting + persisting the rotated secret; arm 2 (native only) re-mints via
 *    the shared-keychain identity when there is no usable secret. It is used BOTH
 *    reactively (wrapped as the `AuthRefreshHandler` installed on `HttpService`)
 *    AND proactively (the scheduler below calls it).
 *  - `createAuthRefreshHandler` / `installAuthRefreshHandler` wire arm 1+2 into
 *    `HttpService.setAuthRefreshHandler`, keeping that layer's single-flight
 *    dedup + cooldown (this module does NOT reimplement them).
 *  - `startTokenRefreshScheduler` — a proactive scheduler decoupled from any
 *    React type: re-mints ~60s before `exp`, re-arms on token change + web
 *    tab-focus, `.unref?.()`s its timer in Node.
 *
 * Framework-free; no module-level mutable state.
 */
import type { DeviceSessionState, DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { OxyServices } from '../OxyServices';
import type { AuthRefreshHandler, AuthRefreshReason } from '../HttpService';
import type { AuthStateStore, PersistedAuthState } from './authStateStore';
import type { IdentityPin } from './identityPin';
import { establishIdentitySession, resolveIdentityPin, type IdentityBinding } from './identitySession';
import { isNative } from '../utils/platform';
import { extractErrorStatus } from '../utils/errorUtils';
import { logger } from '../logger';

/**
 * Lead time (ms) before access-token expiry at which the proactive scheduler
 * re-mints. Mirrors `HttpService`'s per-request `TOKEN_REFRESH_LEAD_SECONDS`
 * (60s) so the scheduled re-mint and the request-time preflight use the same
 * window — the scheduler just fires it during idle/background.
 */
export const TOKEN_REFRESH_LEAD_MS = 60_000;

/**
 * Max `setTimeout` delay (2^31 − 1 ms, ~24.8 days). A larger delay overflows
 * the int32 timer field and fires IMMEDIATELY — with a long-TTL token that
 * turns the reschedule-on-finish loop into a tight busy refresh. Clamp to it.
 */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Floor (ms) on ANY scheduled delay. An already-expired / in-lead-window token
 * computes a non-positive `exp − now − lead`; without this floor that becomes
 * `setTimeout(…, 0)`, and a FAILING re-mint (offline / server error) would
 * re-arm at 0 in the finally block → a tight 100%-CPU busy loop. The floor
 * guarantees every re-arm yields the event loop.
 */
const MIN_SCHEDULE_DELAY_MS = 1_000;

/**
 * Backoff schedule (ms) applied when a scheduled re-mint FAILS: first retry
 * after {@link MIN_FAILURE_BACKOFF_MS}, doubling up to {@link MAX_FAILURE_BACKOFF_MS}.
 * Reset to 0 on any success or token change. This is what converts the former
 * zero-delay failure loop into a bounded, backing-off retry.
 */
const MIN_FAILURE_BACKOFF_MS = 5_000;
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * How long past `exp` to re-mint when a successful refresh handed back a token
 * that is STILL inside the lead window.
 *
 * The device mint returns the session's stored access token until that token
 * has actually expired, so asking again before `exp` only returns the same
 * token. Re-arming from expiry in that state computed a negative delay, hit the
 * {@link MIN_SCHEDULE_DELAY_MS} floor and re-minted once a second for the last
 * minute of every token — 30+ mints, the server's whole per-minute budget, and
 * the 429 that followed straddled the real expiry. Waiting until just past
 * `exp` asks exactly once more, when the server will rotate. The margin covers
 * the server's strict `exp < now` comparison and a little clock skew.
 */
export const REMINT_AFTER_EXPIRY_MS = 2_000;

export interface RefreshDeps {
  oxy: OxyServices;
  store: AuthStateStore;
  /**
   * Whether to fall back to the native shared-keychain re-mint (arm 2) when the
   * persisted secret is absent / rejected. Defaults to `isNative()` — web has no
   * shared keychain. Exposed for tests. IGNORED when {@link identity} is set: an
   * identity-bound client must never adopt the CROSS-APP shared slot, which may
   * hold a different identity than this device's primary key.
   */
  allowSharedKeyFallback?: boolean;
  /**
   * Identity-bound (pinned) mode. When present, every re-mint targets the
   * PINNED account — resolved fresh from the pin store on each call, since a
   * re-established session can move it — instead of the device's active
   * account, and arm 2 becomes the PRIMARY-key identity sign-in rather than the
   * shared-keychain one.
   */
  identity?: IdentityBinding;
}

/**
 * The outcome of ONE device-secret mint attempt (arm 1). Discriminated so both
 * the re-mint handler and the cold boot can react per the transport contract
 * without re-classifying the raw error:
 *  - `ok` — minted, persisted `nextDeviceSecret`, planted the token.
 *  - `no-secret` — the store holds no `deviceId` + `deviceSecret` to mint from.
 *  - `invalid-secret` — 401 `invalid_device_secret`: the presented secret
 *    no longer matches the server's stored hash.
 *  - `no-session` — 401 `no_active_session`: the device is known but has no live
 *    session (authoritative signed-out).
 *  - `account-not-on-device` — 401 `account_not_on_device` for a PINNED mint: the
 *    pinned account is not (or no longer) a live account of this device session.
 *    The device secret is FINE — it is the identity binding that went stale, so
 *    the caller must re-establish from the local key, never drop the credential.
 *  - `transient` — network / 5xx; keep the secret, a later attempt can succeed.
 *  - `session-ended` — the mint succeeded, but the local session was ended
 *    (`HttpService.endSession`, i.e. a sign-out) while it was in flight. Nothing
 *    is planted. The rotated secret is persisted only if the store still holds
 *    the credential that was presented — a store the sign-out cleared stays
 *    clear.
 *  - `persist-failed` — the mint succeeded but `nextDeviceSecret` could NOT be
 *    durably persisted. The token is deliberately NOT planted: advertising a
 *    healthy session on a secret that will not survive a reload is exactly the
 *    divergence that logs users out.
 */
export type DeviceSecretMintOutcome =
  | { status: 'ok'; token: string; sessionId: string; userId: string; state: DeviceSessionState }
  | { status: 'no-secret' }
  | { status: 'invalid-secret' }
  | { status: 'no-session' }
  | { status: 'account-not-on-device' }
  | { status: 'transient' }
  | { status: 'session-ended' }
  | { status: 'persist-failed' };

/**
 * Arm 1 — the device-secret mint, run under the owning client's PROCESS-WIDE
 * single-flight (`httpService.runSingleFlightDeviceSecretMint`).
 *
 * Concurrent lanes (cold boot, the proactive scheduler, a request-time preflight,
 * a 401 retry, the socket token transport, or a tab-focus reconcile) must not
 * each persist a different view of the mint response. Routing EVERY lane through
 * this one single-flight makes concurrent callers await the SAME in-flight mint
 * and all receive its result, so the durable store converges on one credential.
 *
 * On success it persists `nextDeviceSecret` (read-back-verified) BEFORE planting
 * the access token; a failed durable persist yields `persist-failed` WITHOUT
 * planting. This function performs NO store mutation on failure — the caller
 * applies the drop/clear policy (which differs web vs native) from the returned
 * status.
 *
 * `pin` makes the mint IDENTITY-BOUND: the request carries the pinned
 * `accountId` (so the server mints that account's token without touching
 * `activeAccountId`), and the persisted `sessionId`/`userId` are resolved from
 * the PINNED account entry — never from `state.activeAccountId`, whose drift is
 * exactly what the pin exists to stop.
 */
export async function refreshDeviceSecretArm(deps: {
  oxy: OxyServices;
  store: AuthStateStore;
  /** The identity pin, when this client is identity-bound. */
  pin?: IdentityPin | null;
}): Promise<DeviceSecretMintOutcome> {
  const { oxy, store } = deps;
  const pin = deps.pin ?? null;
  return oxy.httpService.runSingleFlightDeviceSecretMint(async () => {
    const epoch = oxy.httpService.getSessionEpoch();
    const persisted = await store.load();
    if (!persisted?.deviceId || !persisted?.deviceSecret) {
      return { status: 'no-secret' };
    }

    let mint: DeviceTokenMintResponse;
    try {
      // Unpinned callers pass NO third argument at all, so the account-mode call
      // shape (and therefore the request body) is untouched by this feature.
      mint = pin
        ? await oxy.mintFromDeviceSecret(persisted.deviceId, persisted.deviceSecret, {
            accountId: pin.accountId,
          })
        : await oxy.mintFromDeviceSecret(persisted.deviceId, persisted.deviceSecret);
    } catch (error) {
      // 429 keeps the credential like any other transient failure — the secret
      // was never judged — but it must NOT retry on the transient cadence. The
      // request-driven lanes (request-time preflight, 401 retry) reattempt every
      // second once the access token is expired, which is 60 mints/min against a
      // 30/min server budget: the client's own retries then hold the limiter
      // tripped and the session cannot recover while the app keeps making
      // requests. Telling HttpService lengthens the next cooldown to one attempt
      // per limiter window, which lets the budget drain and the session heal.
      if (extractErrorStatus(error) === 429) {
        oxy.httpService.noteRefreshRateLimited();
        return { status: 'transient' };
      }
      if (extractErrorStatus(error) === 401) {
        // Structural read (not `instanceof Error`): the thrown value can be a
        // plain ApiError-shaped object or come from another realm.
        const message = (error as { message?: unknown })?.message;
        const body = typeof message === 'string' ? message : '';
        // ONLY the server's explicit `invalid_device_secret` proves the presented
        // secret is bad and may clear the durable device credential. `no_active_session`
        // is an authoritative signed-out. ANY OTHER 401 — a middleware/CSRF/proxy 401,
        // an ALB/starting-instance 401, a CORS error page, etc., all common during a
        // deploy/restart window — is NOT proof the secret diverged: treat it as
        // transient and KEEP the credential so a later attempt self-heals. Wiping the
        // credential on an ambiguous 401 is what logged users out on every deploy,
        // ecosystem-wide.
        if (body.includes('invalid_device_secret')) return { status: 'invalid-secret' };
        if (body.includes('no_active_session')) return { status: 'no-session' };
        // A pinned mint whose account left the device set. The secret is intact —
        // never classify this as a bad secret, or the caller would drop a healthy
        // credential over a stale identity binding.
        if (body.includes('account_not_on_device')) return { status: 'account-not-on-device' };
        return { status: 'transient' };
      }
      return { status: 'transient' };
    }

    // The account this session is BOUND to: the pinned one when identity-bound
    // (the server already minted for it), else the device's active account.
    const boundAccountId = pin ? pin.accountId : mint.state.activeAccountId;
    const bound = mint.state.accounts.find((a) => a.accountId === boundAccountId);
    const next: PersistedAuthState = {
      ...persisted,
      deviceId: mint.state.deviceId,
      deviceSecret: mint.nextDeviceSecret,
      accessToken: mint.accessToken,
      expiresAt: mint.expiresAt,
      ...(bound ? { sessionId: bound.sessionId, userId: bound.accountId } : {}),
    };
    if (oxy.httpService.getSessionEpoch() !== epoch) {
      // Signed out while minting. The server has rotated the secret, so a store
      // that still holds the presented one must learn the rotation (the
      // token-null lane keeps the store so a reload can restore); a store the
      // sign-out cleared must NOT be refilled. Either way, plant nothing.
      const current = await store.load();
      if (current?.deviceId === persisted.deviceId && current.deviceSecret === persisted.deviceSecret) {
        await store.save(next);
      }
      return { status: 'session-ended' };
    }
    // Persist nextDeviceSecret (read-back-verified) BEFORE planting the token.
    // A failed durable persist must NOT plant.
    const persistedOk = await store.save(next);
    if (!persistedOk) {
      return { status: 'persist-failed' };
    }
    if (oxy.httpService.getSessionEpoch() !== epoch) {
      return { status: 'session-ended' };
    }
    oxy.setTokens(mint.accessToken);
    return {
      status: 'ok',
      token: mint.accessToken,
      sessionId: next.sessionId,
      userId: next.userId,
      state: mint.state,
    };
  });
}

/**
 * Re-mint the persisted session and return the fresh access token, or `null`
 * when no arm could produce one.
 *
 * Arm 1 (`POST /session/device/token`, via {@link refreshDeviceSecretArm}): mint
 * from the persisted `deviceId` + `deviceSecret`. On a 401 the secret is diverged
 * or the device has no live session: drop the secret so the mint lane stops (or
 * clear the store on web, where there is no fallback), then fall to arm 2 on
 * native. A transient error — or a durable-persist failure — leaves the store and
 * returns `null` WITHOUT falling to shared-key (those are not bad-secret signals).
 *
 * Arm 2 (native shared-keychain): when the secret is absent or was just rejected,
 * re-mint via `signInWithSharedIdentity` (which plants tokens). On success the
 * recovered `{deviceId, deviceSecret, …}` is PERSISTED so the fast device-secret
 * lane is repopulated (mirrors the cold boot's `shared-key-signin` step) — an
 * in-session shared-key recovery must not leave the fast-lane credential empty.
 *
 * IDENTITY-BOUND clients (`deps.identity`) run a different arm 2: the
 * shared-keychain lane is DISABLED (its cross-app slot may hold a different
 * identity) and replaced by {@link establishIdentitySession}, which re-signs a
 * challenge with the PRIMARY local key and rewrites the pin. Arm 1 is pinned.
 */
export async function refreshPersistedSession(deps: RefreshDeps): Promise<string | null> {
  const { oxy, store } = deps;
  const identity = deps.identity ?? null;
  // The shared keychain is never an identity-bound client's recovery path.
  const allowSharedKeyFallback = identity ? false : (deps.allowSharedKeyFallback ?? isNative());
  const epoch = oxy.httpService.getSessionEpoch();
  // Resolved per call: a re-established identity session can move the pin, and a
  // replaced/removed local key clears it (in which case arm 1 must NOT mint —
  // an unpinned mint would adopt whatever account the device switched to).
  const pin = identity ? await resolveIdentityPin(identity) : null;
  if (identity && !pin) {
    return recoverIdentitySession(oxy, store, identity);
  }

  const arm1 = await refreshDeviceSecretArm({ oxy, store, pin });
  switch (arm1.status) {
    case 'ok':
      return arm1.token;
    case 'session-ended':
      return null;
    case 'transient':
      logger.debug(
        'Persisted deviceSecret mint failed (transient) — keeping store',
        { component: 'refresh', method: 'refreshPersistedSession' },
      );
      return null;
    case 'persist-failed':
      // The server rotated the secret but it did not durably persist. Do NOT fall
      // to shared-key and do NOT plant — a later attempt re-mints (the process
      // mirror still holds the rotated secret the server accepts) and can persist
      // once storage recovers. Never advertise a session on an unsaved secret.
      logger.error(
        'Device-secret mint rotated the secret but it could not be durably persisted — refusing to plant (a later attempt re-mints)',
        undefined,
        { component: 'refresh', method: 'refreshPersistedSession' },
      );
      return null;
    case 'invalid-secret':
    case 'no-session': {
      // 401: secret diverged or no live session. When a key-based arm 2 can still
      // recover (native shared key, or an identity-bound client's own primary
      // key) drop ONLY the secret and keep the deviceId; otherwise (web) the
      // session is over — clear the store.
      const persisted = await store.load();
      if (allowSharedKeyFallback || identity) {
        if (persisted) {
          await store.save({ ...persisted, deviceSecret: undefined });
        }
      } else {
        await store.clear();
      }
      break;
    }
    case 'account-not-on-device':
      // The pinned account left this device's session set. The secret is healthy —
      // leave the store untouched and let the identity arm re-establish.
      logger.debug(
        'Pinned device-secret mint rejected: the pinned account is no longer on this device — re-establishing from the identity key',
        { component: 'refresh', method: 'refreshPersistedSession' },
      );
      break;
    case 'no-secret':
      break;
  }

  if (identity) {
    return recoverIdentitySession(oxy, store, identity);
  }

  // Never after a sign-out: the shared keychain holds an identity KEY, not a
  // session, and using it here would sign the user straight back in.
  if (allowSharedKeyFallback && !oxy.httpService.hasSessionEnded()) {
    try {
      // Planted here, not by the sign-in: a sign-out that lands while the
      // challenge round-trips must win, or the shared keychain signs the user
      // straight back in.
      const session = await oxy.signInWithSharedIdentity({ plantTokens: false });
      if (session?.accessToken) {
        if (oxy.httpService.getSessionEpoch() !== epoch) {
          return null;
        }
        // Repopulate the fast device-secret lane from the shared-key re-mint.
        if (session.deviceId && session.deviceSecret) {
          await store.save({
            sessionId: session.sessionId,
            userId: session.user.id,
            deviceId: session.deviceId,
            deviceSecret: session.deviceSecret,
            accessToken: session.accessToken,
            expiresAt: session.expiresAt,
          });
        }
        if (oxy.httpService.getSessionEpoch() !== epoch) {
          return null;
        }
        oxy.setTokens(session.accessToken);
        return session.accessToken;
      }
    } catch (error) {
      logger.debug(
        'Shared-key re-mint fallback failed',
        { component: 'refresh', method: 'refreshPersistedSession' },
        error,
      );
    }
  }

  return null;
}

/**
 * Arm 2 for an IDENTITY-BOUND client: re-establish the session from the PRIMARY
 * local key and rewrite the pin (`establishIdentitySession` plants the token and
 * persists the device credential itself).
 *
 * Returns `null` — never throws — when there is no local identity, the verify
 * yielded no token, or the exchange failed: the caller treats that as "could not
 * refresh", exactly like the shared-key arm. A locked keychain therefore ends
 * signed out rather than falling back to the device's active account.
 */
async function recoverIdentitySession(
  oxy: OxyServices,
  store: AuthStateStore,
  binding: IdentityBinding,
): Promise<string | null> {
  try {
    const established = await establishIdentitySession({ oxy, store, binding });
    return established?.session.accessToken ?? null;
  } catch (error) {
    logger.debug(
      'Identity-key re-sign-in failed',
      { component: 'refresh', method: 'recoverIdentitySession' },
      error,
    );
    return null;
  }
}

/**
 * Build the reactive `AuthRefreshHandler` (arm 1 + arm 2). Install it via
 * {@link installAuthRefreshHandler} or directly on
 * `oxy.httpService.setAuthRefreshHandler`. `HttpService` owns single-flight
 * dedup + cooldown, so the timer, the request-time preflight, and a 401 all
 * collapse to one network attempt.
 */
export function createAuthRefreshHandler(deps: RefreshDeps): AuthRefreshHandler {
  return async (_reason: AuthRefreshReason): Promise<string | null> => {
    return refreshPersistedSession(deps);
  };
}

/**
 * Install the unified refresh handler on the owner client's `HttpService`.
 * Returns a disposer that removes it.
 */
export function installAuthRefreshHandler(deps: RefreshDeps): () => void {
  deps.oxy.httpService.setAuthRefreshHandler(createAuthRefreshHandler(deps));
  return () => {
    deps.oxy.httpService.setAuthRefreshHandler(null);
  };
}

/** Handle returned by {@link startTokenRefreshScheduler}; `dispose()` tears it down. */
export interface TokenRefreshSchedulerHandle {
  dispose(): void;
}

/**
 * Start the proactive re-mint scheduler against `oxy`.
 *
 * Schedules a single timer to fire {@link TOKEN_REFRESH_LEAD_MS} before the
 * current access token's `exp`, calling
 * `oxy.httpService.refreshAccessToken('preflight')` (which runs the installed
 * handler; deduped + cooldown-guarded). After every attempt it reschedules
 * from the possibly-rotated token. It also reschedules whenever the token
 * changes (a sign-out that clears the token cancels the timer) and, on web
 * tab-focus, re-mints immediately if already inside the lead window (a
 * long-hidden tab throttles timers, so the token can be expired on return).
 *
 * No-ops cleanly when there is no token or an opaque/no-`exp` token — the
 * reactive 401 path stays the only re-mint trigger in that case. The timer is
 * `.unref?.()`-ed so it never keeps a Node/Jest event loop alive.
 */
export function startTokenRefreshScheduler(oxy: OxyServices): TokenRefreshSchedulerHandle {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 0 = no active backoff; grows on consecutive failures, resets on success /
  // token change. Keeps a failing re-mint from re-arming at zero delay.
  let failureBackoffMs = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Arm the timer for `delayMs`, flooring at {@link MIN_SCHEDULE_DELAY_MS} and capping at the int32 max. */
  const armTimer = (delayMs: number): void => {
    clearTimer();
    const clamped = Math.min(Math.max(delayMs, MIN_SCHEDULE_DELAY_MS), MAX_TIMEOUT_DELAY_MS);
    timer = setTimeout(runRefresh, clamped);
    // Never keep a Node/Jest event loop alive for a background re-mint timer.
    timer.unref?.();
  };

  /** Schedule the next re-mint from the current token's expiry (the healthy path). */
  const scheduleFromExpiry = (): void => {
    clearTimer();
    if (disposed || !oxy.getAccessToken()) {
      return;
    }
    const expSeconds = oxy.getAccessTokenExpiry();
    if (expSeconds === null) {
      return;
    }
    const untilExpiryMs = expSeconds * 1000 - Date.now();
    // The server already answered this token's refresh with this very token:
    // asking again before `exp` only gets it back again. Ask just after expiry,
    // when the server rotates (see REMINT_AFTER_EXPIRY_MS).
    if (untilExpiryMs > 0 && oxy.httpService.isAwaitingCurrentTokenExpiry?.()) {
      armTimer(untilExpiryMs + REMINT_AFTER_EXPIRY_MS);
      return;
    }
    armTimer(untilExpiryMs - TOKEN_REFRESH_LEAD_MS);
  };

  const runRefresh = (): void => {
    // Clear any pending timer up front so an out-of-band trigger (focus) plus
    // a fired timer can never double-run.
    clearTimer();
    // Another lane (a request-time preflight) already asked, and the server
    // answered with this same token: re-arm for just past expiry instead.
    if (oxy.httpService.isAwaitingCurrentTokenExpiry?.()) {
      scheduleFromExpiry();
      return;
    }
    void oxy.httpService.refreshAccessToken('preflight')
      .then((token) => Boolean(token))
      .catch(() => false)
      .then((ok) => {
        if (disposed) {
          return;
        }
        if (ok) {
          // Success — drop any backoff and re-arm from the rotated token's exp.
          failureBackoffMs = 0;
          scheduleFromExpiry();
          return;
        }
        // Failure — back off (never re-arm at zero) and retry.
        failureBackoffMs =
          failureBackoffMs === 0
            ? MIN_FAILURE_BACKOFF_MS
            : Math.min(failureBackoffMs * 2, MAX_FAILURE_BACKOFF_MS);
        armTimer(failureBackoffMs);
      });
  };

  /** Public (re)schedule entry: a fresh token / focus signal — drop backoff and arm from expiry. */
  const schedule = (): void => {
    failureBackoffMs = 0;
    scheduleFromExpiry();
  };

  const onFocus = (): void => {
    if (disposed || !oxy.getAccessToken()) {
      return;
    }
    const expSeconds = oxy.getAccessTokenExpiry();
    if (expSeconds === null) {
      return;
    }
    const remainingMs = expSeconds * 1000 - Date.now();
    if (remainingMs <= TOKEN_REFRESH_LEAD_MS) {
      runRefresh();
    } else {
      schedule();
    }
  };

  // Re-arm only on a token that actually CHANGED. The mint plants the token it
  // returns even when that is the token already held, and treating the repeat
  // as new re-armed from an in-lead-window expiry, i.e. at the 1s floor.
  let lastSeenToken = oxy.getAccessToken();
  const unsubscribeTokens = oxy.onTokensChanged((token) => {
    if (disposed || token === lastSeenToken) {
      return;
    }
    lastSeenToken = token;
    schedule();
  });

  let removeFocusListener: (() => void) | null = null;
  if (typeof document !== 'undefined') {
    const handler = (): void => {
      if (document.visibilityState === 'visible') {
        onFocus();
      }
    };
    document.addEventListener('visibilitychange', handler);
    removeFocusListener = () => document.removeEventListener('visibilitychange', handler);
  }

  schedule();

  return {
    dispose(): void {
      disposed = true;
      clearTimer();
      unsubscribeTokens();
      removeFocusListener?.();
      removeFocusListener = null;
    },
  };
}
