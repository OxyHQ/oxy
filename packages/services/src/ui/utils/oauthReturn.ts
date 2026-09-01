import type { OxyServices } from '@oxyhq/core';
import {
  clearOAuthHandshake,
  consumeOAuthReturnPath,
  logger,
  canonicalizeOAuthRedirectUri,
  readOAuthHandshake,
} from '@oxyhq/core';
import { completeOAuthCode } from '../oauth/completeOAuthCode';
import type { OAuthSessionCommitInput } from '../oauth/types';
import { isWebBrowser } from './isWebBrowser';

/**
 * When the RP lands with `?code=` after signing in at auth.oxy.so, exchange the
 * code for a device-first session before cold boot runs.
 *
 * This is the REDIRECT transport's return leg. The SDK never starts a full-page
 * authorize navigation on its own any more (#691 phase 7b), but this lane is
 * still load-bearing: a browser-BLOCKED sign-in popup falls back to a full-page
 * redirect (`startWebOAuthSignIn`), and that redirect comes back here.
 *
 * It owns only what is specific to a full-page round trip — reading the code off
 * the URL, recovering the handshake `sessionStorage` carried across the
 * navigation, and cleaning both up afterwards — and delegates state validation,
 * the PKCE exchange, and the session commit to `completeOAuthCode`, the same
 * function the popup transport runs.
 *
 * It is also the SINGLE cleanup path for an OAuth `error` landing on the URL:
 * any `?error=…` (including an `error=login_required` left over from the
 * now-deleted silent restore) is stripped along with `state` /
 * `error_description`, and the stale PKCE handshake is cleared.
 */
export async function tryCompleteOAuthReturn(opts: {
  oxyServices: OxyServices;
  clientId?: string | null;
  authRedirectUri?: string;
  commitSession: (input: OAuthSessionCommitInput) => Promise<void>;
}): Promise<boolean> {
  if (!isWebBrowser()) return false;
  const location = (globalThis as { location?: Location }).location;
  if (!location) return false;

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const oauthError = params.get('error');
  if (oauthError) {
    stripOAuthParamsFromUrl();
    clearOAuthHandshake();
    return false;
  }
  if (!code) return false;

  const clientId = opts.clientId;
  if (!clientId) {
    logger.warn('OAuth return ignored: missing clientId', { component: 'oauthReturn' });
    stripOAuthParamsFromUrl();
    clearOAuthHandshake();
    return false;
  }

  const handshake = readOAuthHandshake();
  const redirectUri = canonicalizeOAuthRedirectUri(
    handshake?.redirectUri ?? opts.authRedirectUri ?? location.origin,
  );

  const result = await completeOAuthCode({
    oxyServices: opts.oxyServices,
    clientId,
    code,
    returnedState: params.get('state'),
    handshake,
    redirectUri,
    commitSession: opts.commitSession,
    // Strip the params before the commit so a stale `?code=` cannot re-enter the
    // exchange loop, and read the return path FIRST — clearOAuthHandshake drops
    // it along with the PKCE keys.
    cleanup: () => {
      stripOAuthParamsFromUrl();
      clearOAuthHandshake();
    },
  });
  return result.ok;
}

/**
 * Rewrite the address bar after an authorize round trip, and tell the router.
 *
 * Prefers the page the visit started on (see `persistOAuthReturnPath`) over the
 * bare origin the IdP redirected to, falling back to `fallbackUrl` when nothing
 * was recorded.
 *
 * The `popstate` dispatch is the load-bearing part. `history.replaceState`
 * fires no event, and cold boot runs *inside* the mounted app — by the time
 * this executes, a history-based router (React Router, Vue Router, …) has
 * already read `location` and rendered the route for `/`. Without a
 * notification the address bar would show the restored deep link while the page
 * still displayed the home page. `popstate` is the event the History API
 * defines for exactly this, and it is what those routers subscribe to.
 *
 * Only dispatched when the URL actually changed, so the common no-op case does
 * not push a spurious event at every listener on the page.
 */
export function replaceUrlAfterOAuthReturn(fallbackUrl: string): void {
  const location = (globalThis as { location?: Location }).location;
  const history = (globalThis as { history?: History }).history;
  if (!location || !history?.replaceState) return;

  const current = `${location.pathname}${location.search}${location.hash}`;
  const target = consumeOAuthReturnPath() ?? fallbackUrl;
  history.replaceState(history.state, '', target);
  if (target === current) return;

  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  if (typeof dispatch !== 'function') return;
  try {
    // `PopStateEvent` is web-only; plain `Event` is a good enough carrier for
    // any host that lacks it (routers read `location`, not `event.state`).
    const event =
      typeof PopStateEvent === 'function'
        ? new PopStateEvent('popstate', { state: history.state })
        : new Event('popstate');
    dispatch.call(globalThis, event);
  } catch (error) {
    logger.warn('Could not notify router of restored URL', { component: 'oauthReturn' }, error);
  }
}

function stripOAuthParamsFromUrl(): void {
  const location = (globalThis as { location?: Location; history?: History }).location;
  const history = (globalThis as { history?: History }).history;
  if (!location || !history?.replaceState) return;
  const url = new URL(location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  replaceUrlAfterOAuthReturn(`${url.pathname}${url.search}${url.hash}`);
}
