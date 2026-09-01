/**
 * The single web entry point for third-party "Sign in with Oxy".
 *
 * Picks the transport (`popup` or `redirect`), drives it, and returns ONE typed
 * result — so callers (`OxySignInButton`, and any RP with its own button) never
 * touch `window.open`, `postMessage`, or the token exchange themselves.
 *
 * Popup mode keeps the relying party mounted: its route, scroll position, and
 * unsaved state survive because the tab never navigates. Redirect mode is the
 * compatibility fallback, and is also where popup mode lands when the browser
 * blocks the window — a blocked popup must still sign the user in, not dead-end.
 *
 * Native is NOT handled here: `openAuthorizeUrlNative` (an in-app auth session)
 * remains the native lane and is untouched by this module.
 */

import { logger, persistOAuthHandshake } from '@oxyhq/core';
import type { OxyServices } from '@oxyhq/core';
import { redirectToAuthorize } from '../components/oauthNavigation';
import { isWebBrowser } from '../utils/isWebBrowser';
import { completeOAuthCode } from './completeOAuthCode';
import { prepareAuthorizeRequest } from './oauthHandshake';
import { awaitOAuthPopupResult, closeOAuthPopup, navigateOAuthPopup, openOAuthPopup } from './oauthPopup';
import type {
  OAuthPopupHandle,
  OAuthSessionCommitInput,
  WebAuthMode,
  WebOAuthRedirectReason,
  WebOAuthSignInResult,
} from './types';

/** Provider-owned wiring for a web sign-in — everything that is not per-press. */
export interface WebOAuthTransportContext {
  /** The provider's `webAuthMode`. */
  mode: WebAuthMode;
  oxyServices: OxyServices;
  /** The app's registered client id; `null` disables third-party sign-in. */
  clientId: string | null;
  /** Authorize endpoint override (local/staging deployments). */
  authorizeBaseUrl?: string;
  /** `sessionMode: 'identity'` — no third-party OAuth lane exists by design. */
  identityBound: boolean;
  /** The provider's session commit funnel. */
  commitSession: (input: OAuthSessionCommitInput) => Promise<void>;
}

/** Per-press inputs for {@link startWebOAuthSignIn}. */
export interface StartWebOAuthSignInOptions {
  /** EXACT registered redirect URI for this application. */
  redirectUri: string;
  /**
   * The popup to drive, when the caller already opened one.
   *
   * - omitted — this call opens the window itself, which is only valid when it
   *   was invoked SYNCHRONOUSLY from the user's click (gesture attribution);
   * - `null` — the caller tried and the browser blocked it: fall back to a
   *   full-page redirect;
   * - a handle — use exactly this window.
   *
   * Callers that must `await` before signing in (resolving the application, for
   * instance) have to open the window in their press handler and pass it here;
   * a window opened after an `await` is silently blocked by every browser.
   */
  popup?: OAuthPopupHandle | null;
  /** Requested scope; defaults to the SDK's standard sign-in scope. */
  scope?: string;
  /** Popup timeout override (ms). */
  timeoutMs?: number;
}

export async function startWebOAuthSignIn(
  context: WebOAuthTransportContext,
  options: StartWebOAuthSignInOptions,
): Promise<WebOAuthSignInResult> {
  if (!isWebBrowser()) {
    closeOAuthPopup(options.popup ?? null);
    return { status: 'unsupported', reason: 'no-browser' };
  }
  if (context.identityBound) {
    closeOAuthPopup(options.popup ?? null);
    return { status: 'unsupported', reason: 'identity-bound' };
  }
  if (!context.clientId) {
    closeOAuthPopup(options.popup ?? null);
    return { status: 'unsupported', reason: 'missing-client-id' };
  }

  // Claim the window BEFORE the first `await` below, so a caller that invoked us
  // straight from the click still has gesture attribution. An explicit `null`
  // means the caller already tried and was blocked.
  const popup =
    context.mode === 'popup' && options.popup === undefined ? openOAuthPopup() : options.popup ?? null;

  if (context.mode === 'redirect') {
    closeOAuthPopup(popup);
    return startRedirectSignIn(context, options, 'redirect-mode');
  }
  if (!popup) {
    logger.warn('OAuth sign-in popup was blocked; falling back to a full-page redirect', {
      component: 'browserAuthTransport',
    });
    return startRedirectSignIn(context, options, 'popup-blocked');
  }

  try {
    const prepared = await prepareAuthorizeRequest({
      clientId: context.clientId,
      redirectUri: options.redirectUri,
      authorizeBaseUrl: context.authorizeBaseUrl,
      scope: options.scope,
      responseMode: 'web_message',
    });

    if (!navigateOAuthPopup(popup, prepared.authorizeUrl)) {
      return startRedirectSignIn(context, options, 'popup-navigation-failed');
    }

    const outcome = await awaitOAuthPopupResult({
      popup,
      expectedOrigin: prepared.authorizeOrigin,
      expectedState: prepared.handshake.state,
      redirectUri: options.redirectUri,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    switch (outcome.kind) {
      case 'code': {
        const completion = await completeOAuthCode({
          oxyServices: context.oxyServices,
          clientId: context.clientId,
          code: outcome.code,
          returnedState: outcome.state,
          handshake: prepared.handshake,
          redirectUri: options.redirectUri,
          commitSession: context.commitSession,
        });
        return completion.ok
          ? { status: 'signed-in' }
          : { status: 'failed', reason: completion.reason };
      }
      case 'oauth-error':
        return {
          status: 'failed',
          reason: 'idp-error',
          description: outcome.errorDescription ?? outcome.error,
        };
      case 'state-mismatch':
        return { status: 'failed', reason: 'state-mismatch' };
      case 'closed':
        return { status: 'cancelled' };
      case 'timed-out':
        return { status: 'timed-out' };
      case 'unsupported':
        return { status: 'unsupported', reason: 'no-browser' };
    }
  } finally {
    // Covers throws after open (prepare/exchange/commit) and every settled outcome.
    closeOAuthPopup(popup);
  }
}

/**
 * Full-page hand-off to the IdP. The document is destroyed by the navigation, so
 * the handshake MUST reach `sessionStorage` first — without it the return trip
 * cannot validate `state`, and starting the redirect anyway would strand the
 * user at a callback that can only refuse them.
 */
async function startRedirectSignIn(
  context: WebOAuthTransportContext,
  options: StartWebOAuthSignInOptions,
  via: WebOAuthRedirectReason,
): Promise<WebOAuthSignInResult> {
  // Narrowed by the caller; repeated here so this helper is safe on its own.
  if (!context.clientId) return { status: 'unsupported', reason: 'missing-client-id' };

  const prepared = await prepareAuthorizeRequest({
    clientId: context.clientId,
    redirectUri: options.redirectUri,
    authorizeBaseUrl: context.authorizeBaseUrl,
    scope: options.scope,
  });

  if (!persistOAuthHandshake(
    prepared.handshake.state,
    prepared.handshake.codeVerifier,
    options.redirectUri,
  )) {
    return { status: 'failed', reason: 'handshake-storage' };
  }

  redirectToAuthorize(prepared.authorizeUrl);
  return { status: 'redirecting', via };
}
