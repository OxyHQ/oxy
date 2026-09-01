/**
 * Popup lifecycle for the web OAuth transport.
 *
 * Owns the window itself — opening it, navigating it, watching it, and tearing
 * every listener and timer down — and nothing else: message validation lives in
 * `oauthPopupMessages.ts`, and the code exchange in `completeOAuthCode.ts`.
 *
 * Three browser realities shape this module:
 *
 * - **Gesture attribution.** `window.open` only succeeds while the user's click
 *   is still being handled. Anything awaited first (resolving the application,
 *   generating PKCE) loses it and the popup is silently blocked. So the window
 *   is opened EMPTY up front and navigated once the authorize URL exists —
 *   the same shape as `passkeyHubPopup.ts`.
 * - **No close event.** A cross-origin popup fires nothing when the user
 *   dismisses it; polling `closed` is the only mechanism (as in core's
 *   `AccountDialogController.watchPopup`).
 * - **No cross-origin reads.** The popup's URL, title, and document are all
 *   opaque. The authorization result arrives ONLY as a `postMessage`.
 */

import { canonicalizeOAuthRedirectUri, logger } from '@oxyhq/core';
import { readOAuthPopupMessage } from './oauthPopupMessages';
import type { OAuthPopupHandle, OAuthPopupOutcome } from './types';

/**
 * Window name for the sign-in popup. Naming the target means a second press
 * REUSES the same window instead of stacking a new one behind the first.
 */
export const OXY_OAUTH_POPUP_WINDOW_NAME = 'oxy-oauth';

/** Chrome-free window roughly sized for the IdP's sign-in / QR surface. */
const POPUP_FEATURES = 'popup=yes,width=460,height=700,menubar=no,toolbar=no,location=no,status=no';

/**
 * How long a popup sign-in may stay unanswered (ms).
 *
 * Generous on purpose: the IdP surface can involve scanning a QR and approving
 * on a phone, so this tracks the authorize handle's own ~5-minute lifetime
 * rather than a UI-scale timeout. It is a backstop against a wedged popup, not
 * a pace-setter — a user who gives up closes the window and gets the faster
 * `closed` outcome.
 */
export const DEFAULT_OAUTH_POPUP_TIMEOUT_MS = 300_000;

/** How often the popup's `closed` flag is sampled (ms). */
const CLOSE_POLL_INTERVAL_MS = 1000;

/**
 * Grace period (ms) after `closed` flips before reporting cancellation.
 *
 * The IdP posts its result and THEN closes itself. Both land as separate tasks,
 * so a poll tick that happens to fall between them would otherwise turn a
 * successful sign-in into a "user cancelled". One short grace window lets the
 * already-queued message win.
 */
const CLOSE_GRACE_MS = 400;

/** The `message` half of the DOM host, absent on native and during SSR. */
interface MessageEventHost {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The `open` half of the DOM host, absent on native and during SSR. */
interface PopupOpenerHost {
  open?: (url: string, target: string, features: string) => OAuthPopupHandle | null;
}

function messageEventHost(): MessageEventHost | null {
  const win = (globalThis as { window?: Partial<MessageEventHost> }).window;
  if (!win || typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function') {
    return null;
  }
  return win as MessageEventHost;
}

/**
 * Open a new, EMPTY sign-in popup.
 *
 * MUST be called SYNCHRONOUSLY from a user-gesture handler, before any `await`.
 * Returns `null` when the browser blocked it, when `window.open` threw, and on
 * hosts with no DOM (native / SSR) — never throws, because "no popup" is an
 * ordinary outcome the caller answers by falling back to a redirect.
 */
export function openOAuthPopup(): OAuthPopupHandle | null {
  const win = (globalThis as { window?: PopupOpenerHost }).window;
  if (!win || typeof win.open !== 'function') return null;
  try {
    return win.open('', OXY_OAUTH_POPUP_WINDOW_NAME, POPUP_FEATURES) ?? null;
  } catch (error) {
    logger.warn('Could not open the OAuth sign-in popup', { component: 'oauthPopup' }, error);
    return null;
  }
}

/**
 * Point an already-open popup at the authorize URL. Returns `false` when the
 * assignment threw (a window closed between opening and navigating), so the
 * caller can fall back to a redirect instead of waiting on a dead window.
 */
export function navigateOAuthPopup(popup: OAuthPopupHandle, url: string): boolean {
  try {
    popup.location.href = url;
    return true;
  } catch (error) {
    logger.warn('Could not navigate the OAuth sign-in popup', { component: 'oauthPopup' }, error);
    return false;
  }
}

/** Close the popup if it is still open. Idempotent, null-safe, never throws. */
export function closeOAuthPopup(popup: OAuthPopupHandle | null): void {
  if (!popup || popup.closed) return;
  try {
    popup.close();
  } catch (error) {
    logger.debug('OAuth popup close failed', { component: 'oauthPopup' }, error);
  }
}

/**
 * When the IdP falls back to a top-level redirect inside the popup (no usable
 * `window.opener`), a same-origin `redirect_uri` is readable from the opener.
 * Cross-origin redirects remain opaque and are not handled here.
 */
function readSameOriginRedirectOutcome(
  popup: OAuthPopupHandle,
  redirectUri: string,
  expectedState: string,
): OAuthPopupOutcome | null {
  try {
    const href = popup.location.href;
    if (!href) return null;

    const popupUrl = new URL(href);
    const expected = new URL(canonicalizeOAuthRedirectUri(redirectUri));
    if (popupUrl.origin !== expected.origin) return null;
    if (popupUrl.pathname !== expected.pathname) return null;

    const oauthError = popupUrl.searchParams.get('error');
    if (oauthError) {
      const errorDescription = popupUrl.searchParams.get('error_description') ?? undefined;
      return {
        kind: 'oauth-error',
        error: oauthError,
        ...(errorDescription ? { errorDescription } : {}),
      };
    }

    const code = popupUrl.searchParams.get('code');
    if (!code) return null;

    const state = popupUrl.searchParams.get('state');
    if (!state || state !== expectedState) return { kind: 'state-mismatch' };
    return { kind: 'code', code, state };
  } catch {
    // Cross-origin navigation — the popup URL is opaque to the opener.
    return null;
  }
}

/** Inputs for {@link awaitOAuthPopupResult}. */
export interface AwaitOAuthPopupOptions {
  /** The exact window reference returned by {@link openOAuthPopup}. */
  popup: OAuthPopupHandle;
  /** Exact origin the IdP will post from (`new URL(authorizeUrl).origin`). */
  expectedOrigin: string;
  /** The CSRF `state` sent on the authorize request. */
  expectedState: string;
  /**
   * EXACT registered redirect URI for this attempt. When the IdP cannot
   * `postMessage` (no usable opener) it falls back to redirecting the popup;
   * if that lands on the same origin, the result is read from the popup URL.
   */
  redirectUri: string;
  /** @default DEFAULT_OAUTH_POPUP_TIMEOUT_MS */
  timeoutMs?: number;
}

/**
 * Wait for the popup to deliver an authorization result.
 *
 * Settles EXACTLY once, with a typed outcome for every path — code, IdP error,
 * state mismatch, user-closed, timeout — and removes its listener, its close
 * poll, and both timers before resolving, whatever the outcome. Messages that
 * arrive after settling reach nothing, so a duplicate delivery is inert.
 *
 * Never rejects: closing the window and running out of time are expected
 * outcomes, not exceptions.
 */
export function awaitOAuthPopupResult(
  options: AwaitOAuthPopupOptions,
): Promise<OAuthPopupOutcome> {
  const {
    popup,
    expectedOrigin,
    expectedState,
    redirectUri,
    timeoutMs = DEFAULT_OAUTH_POPUP_TIMEOUT_MS,
  } = options;

  const host = messageEventHost();
  if (!host) return Promise.resolve({ kind: 'unsupported' });

  return new Promise<OAuthPopupOutcome>((resolve) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let closePoll: ReturnType<typeof setInterval> | null = null;

    const onMessage = (event: MessageEvent): void => {
      const verdict = readOAuthPopupMessage(event, { expectedOrigin, expectedState, popup });
      switch (verdict.kind) {
        case 'ignore':
          return;
        case 'code':
          settle({ kind: 'code', code: verdict.code, state: verdict.state });
          return;
        case 'oauth-error':
          settle({
            kind: 'oauth-error',
            error: verdict.error,
            ...(verdict.errorDescription ? { errorDescription: verdict.errorDescription } : {}),
          });
          return;
        case 'state-mismatch':
          settle({ kind: 'state-mismatch' });
          return;
      }
    };

    const cleanup = (): void => {
      host.removeEventListener('message', onMessage);
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (closeGraceTimer !== null) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      if (closePoll !== null) {
        clearInterval(closePoll);
        closePoll = null;
      }
    };

    function settle(outcome: OAuthPopupOutcome): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    host.addEventListener('message', onMessage);

    timeoutTimer = setTimeout(() => settle({ kind: 'timed-out' }), timeoutMs);

    closePoll = setInterval(() => {
      const redirectOutcome = readSameOriginRedirectOutcome(popup, redirectUri, expectedState);
      if (redirectOutcome) {
        settle(redirectOutcome);
        return;
      }

      if (!popup.closed) return;
      // Stop sampling immediately: the window is gone and only the in-flight
      // message (if any) can still change the outcome.
      if (closePoll !== null) {
        clearInterval(closePoll);
        closePoll = null;
      }
      closeGraceTimer = setTimeout(() => settle({ kind: 'closed' }), CLOSE_GRACE_MS);
    }, CLOSE_POLL_INTERVAL_MS);
  });
}
