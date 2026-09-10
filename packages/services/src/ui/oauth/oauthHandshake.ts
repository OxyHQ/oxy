/**
 * The RP half of an OAuth authorize request: a fresh CSRF `state` + PKCE pair,
 * and the authorize URL built from them.
 *
 * Both web transports start here, and the ONLY difference between them is one
 * parameter: `popup` asks the IdP for `response_mode=web_message` so the result
 * comes back to `window.opener` instead of navigating the RP's tab. Everything
 * else — `S256` PKCE, exact registered `redirect_uri`, random `state` — is
 * identical, which is what lets both lanes converge on one completion path.
 */

import { buildOAuthAuthorizeUrl, generateOAuthState, generatePkcePair } from '@oxy.so/core';
import type { OAuthHandshake } from './types';

/** Inputs for {@link prepareAuthorizeRequest}. */
export interface PrepareAuthorizeRequestParams {
  /** The registered `ApplicationCredential` public key (`oxy_dk_…`). */
  clientId: string;
  /** EXACT registered redirect URI. The token exchange must replay this value. */
  redirectUri: string;
  /** Authorize endpoint override; defaults to the production Oxy IdP. */
  authorizeBaseUrl?: string;
  /** Requested scope; defaults to the SDK's standard sign-in scope. */
  scope?: string;
  /**
   * Ask the IdP to deliver the result to `window.opener` via `postMessage`
   * instead of redirecting. Set ONLY by the popup transport. It is a request,
   * not a guarantee — an IdP with no opener still redirects.
   */
  responseMode?: 'web_message';
}

/** A ready-to-use authorize request plus the secrets that finish it. */
export interface PreparedAuthorizeRequest {
  /** Fully-built `auth.oxy.so/authorize` URL. */
  authorizeUrl: string;
  /**
   * Exact origin of {@link authorizeUrl}. The popup transport accepts
   * `postMessage` from this origin and no other.
   */
  authorizeOrigin: string;
  /** The `state` + PKCE verifier this request is bound to. */
  handshake: OAuthHandshake;
}

/**
 * Generate a fresh handshake and build the authorize URL around it.
 *
 * The verifier is returned to the caller and never stored here: the popup
 * transport keeps it in memory for the lifetime of the attempt, and the
 * redirect transport persists it through `persistOAuthHandshake` because a
 * full-page navigation destroys the running document.
 */
export async function prepareAuthorizeRequest(
  params: PrepareAuthorizeRequestParams,
): Promise<PreparedAuthorizeRequest> {
  const [pkce, state] = await Promise.all([generatePkcePair(), generateOAuthState()]);

  const authorizeUrl = buildOAuthAuthorizeUrl({
    authorizeBaseUrl: params.authorizeBaseUrl,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    state,
    codeChallenge: pkce.codeChallenge,
    ...(params.responseMode ? { responseMode: params.responseMode } : {}),
  });

  return {
    authorizeUrl,
    authorizeOrigin: new URL(authorizeUrl).origin,
    handshake: { state, codeVerifier: pkce.codeVerifier },
  };
}
