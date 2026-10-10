/**
 * Typed contracts shared by the browser "Sign in with Oxy" OAuth transports.
 *
 * Two transports deliver the same authorization code to the same completion
 * path (see `completeOAuthCode.ts`):
 *
 * - `redirect` — the historical full-page hand-off to `auth.oxy.so/authorize`.
 *   The RP tab navigates away and comes back to its registered `redirect_uri`
 *   with `?code=…&state=…`; cold boot finishes the exchange.
 * - `popup` — a small `auth.oxy.so` window opened from the user's click. The RP
 *   stays mounted with its route and unsaved state intact; the IdP delivers the
 *   result to `window.opener` via `postMessage` and closes itself.
 *
 * Only the authorization code, the CSRF `state`, and a typed OAuth error ever
 * cross the `postMessage` channel. Access tokens, device secrets, and the PKCE
 * `code_verifier` NEVER do — the opener keeps the verifier and performs the code
 * exchange itself.
 */

/** How a web relying party hands the user to the IdP for third-party sign-in. */
export type WebAuthMode = 'popup' | 'redirect';

/**
 * Minimal structural handle over a popup `Window` — exactly what the popup
 * transport needs: navigate it once the authorize URL is built, detect the user
 * closing it (`closed`, polled — there is no cross-origin close event), and
 * close it programmatically on completion. Satisfied directly by the value
 * `window.open()` returns.
 *
 * Deliberately NOT `Window`: the transport must never read cross-origin
 * properties off the popup, and a narrow handle makes that impossible to do by
 * accident (and trivial to fake in tests).
 */
export interface OAuthPopupHandle {
  readonly closed: boolean;
  close(): void;
  location: { href: string };
}

/**
 * The RP-side OAuth handshake for one authorize request: the CSRF `state` sent
 * to the IdP and the PKCE `code_verifier` replayed on the token exchange.
 *
 * In `redirect` mode it is persisted to `sessionStorage` across the full-page
 * navigation; in `popup` mode it never leaves memory.
 */
export interface OAuthHandshake {
  /** Opaque CSRF token echoed back by the IdP and validated before any exchange. */
  state: string;
  /** The PKCE secret. Never crosses `postMessage`, a URL, or storage in popup mode. */
  codeVerifier: string;
}

/** Successful authorization delivered by the IdP over `postMessage`. */
export interface OxyOAuthCodeMessage {
  type: 'oxy:oauth:code';
  code: string;
  state: string;
}

/** Typed OAuth failure delivered by the IdP over `postMessage`. */
export interface OxyOAuthErrorMessage {
  type: 'oxy:oauth:error';
  error: string;
  errorDescription?: string;
  state?: string;
}

/** The ONLY two message shapes that may cross the popup channel. */
export type OxyOAuthMessage = OxyOAuthCodeMessage | OxyOAuthErrorMessage;

/** Session material handed to the provider's commit funnel after an exchange. */
export interface OAuthSessionCommitInput {
  sessionId: string;
  accessToken?: string;
  deviceId?: string;
  deviceSecret?: string;
  userId: string;
  expiresAt?: string;
  user?: { id: string; username?: string; avatar?: string };
}

/**
 * Terminal outcome of one popup sign-in attempt. Every expected path — the user
 * closing the window, a timeout, an IdP error — is a value, never a thrown
 * exception.
 */
export type OAuthPopupOutcome =
  /** The IdP delivered an authorization code whose `state` matched. */
  | { kind: 'code'; code: string; state: string }
  /** The IdP delivered a typed OAuth error (`access_denied`, `login_required`, …). */
  | { kind: 'oauth-error'; error: string; errorDescription?: string }
  /** A well-formed message from our popup carried the wrong `state`. */
  | { kind: 'state-mismatch' }
  /** The user dismissed the popup without completing sign-in. */
  | { kind: 'closed' }
  /** No result arrived within the allotted window. */
  | { kind: 'timed-out' }
  /** No DOM message host (SSR / native) — the popup transport does not apply. */
  | { kind: 'unsupported' };

/** Why the shared completion path could not produce a session. */
export type OAuthCompletionFailure = 'state-mismatch' | 'exchange-failed';

/** Result of the ONE completion path both transports run. */
export type OAuthCompletionResult = { ok: true } | { ok: false; reason: OAuthCompletionFailure };

/** Why the transport fell back to a full-page redirect. */
export type WebOAuthRedirectReason =
  /** `webAuthMode: 'redirect'` — the configured transport. */
  | 'redirect-mode'
  /** The browser refused `window.open` (blocker, or no gesture attribution). */
  | 'popup-blocked'
  /** The popup opened but could not be navigated to the authorize URL. */
  | 'popup-navigation-failed';

/** Why a web sign-in attempt failed outright. */
export type WebOAuthFailureReason =
  /** The handshake could not be persisted for the redirect return (no/blocked storage). */
  | 'handshake-storage'
  /** The `state` returned by the IdP did not match the one we sent. */
  | 'state-mismatch'
  /** `POST /auth/oauth/token` or the session commit failed. */
  | 'exchange-failed'
  /** The IdP reported a typed OAuth error. */
  | 'idp-error';

/** Why a web sign-in attempt was not applicable at all. */
export type WebOAuthUnsupportedReason =
  /** Not a browser (native / SSR) — native uses `openAuthorizeUrlNative`. */
  | 'no-browser'
  /** `sessionMode: 'identity'` has no third-party OAuth lane by construction. */
  | 'identity-bound'
  /** No `clientId` is configured on the provider. */
  | 'missing-client-id';

/** Terminal, typed outcome of a web third-party sign-in attempt. */
export type WebOAuthSignInResult =
  /** A session was committed; the RP is authenticated without a reload. */
  | { status: 'signed-in' }
  /** The tab is navigating to the IdP; nothing else will resolve in this document. */
  | { status: 'redirecting'; via: WebOAuthRedirectReason }
  /** The user dismissed the popup. */
  | { status: 'cancelled' }
  /** No result arrived within the allotted window. */
  | { status: 'timed-out' }
  | { status: 'failed'; reason: WebOAuthFailureReason; description?: string }
  | { status: 'unsupported'; reason: WebOAuthUnsupportedReason };
