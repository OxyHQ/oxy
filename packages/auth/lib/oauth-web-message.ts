/**
 * Delivery of an OAuth authorization response back to the relying party.
 *
 * Two transports, chosen per request:
 *
 *  - **redirect** (the default): a top-level navigation to the validated
 *    `redirect_uri` carrying `?code=…&state=…` or `?error=…`.
 *  - **web message** (popup sign-in): the relying party asks for it with
 *    `response_mode=web_message` on the authorize URL. The result is
 *    `postMessage`d to `window.opener` and this window closes, so the relying
 *    party's own tab is never navigated.
 *
 * The web-message transport is a REQUEST, not a guarantee: without a usable
 * opener (or with a redirect target that has no web origin) delivery falls back
 * to the redirect. Relying parties must handle both outcomes.
 *
 * SECURITY INVARIANTS — the reason this logic lives in one small, tested module:
 *
 *  1. The target origin is ALWAYS the exact origin of the redirect URI the API
 *     accepted for this request; it is NEVER `'*'` and never a wildcard
 *     fallback. `POST /auth/oauth/authorize` validates that URI by exact
 *     constant-time match against the application's registered `redirectUris`,
 *     so its origin is a registered origin — that server-side validation is what
 *     makes this target trustworthy. A redirect URI with no web origin (a native
 *     scheme, whose `URL.origin` is the opaque `"null"`) can never be a target.
 *  2. The ONLY values that cross the window boundary are the single-use
 *     authorization code, the `state` echo, and a standard OAuth error code
 *     (with an optional description). Never a token, session id, device secret,
 *     or user object — the message shapes below are exhaustive.
 */

/** `response_mode` value with which a relying party requests popup delivery. */
export const WEB_MESSAGE_RESPONSE_MODE = 'web_message';

/** Message type carrying a successful authorization. */
export const OAUTH_CODE_MESSAGE_TYPE = 'oxy:oauth:code';

/** Message type carrying a failed or denied authorization. */
export const OAUTH_ERROR_MESSAGE_TYPE = 'oxy:oauth:error';

/** Successful authorization delivered to the opener. */
export interface OAuthCodeMessage {
  type: typeof OAUTH_CODE_MESSAGE_TYPE;
  code: string;
  state: string;
}

/** Failed or denied authorization delivered to the opener. */
export interface OAuthErrorMessage {
  type: typeof OAUTH_ERROR_MESSAGE_TYPE;
  error: string;
  errorDescription?: string;
  state?: string;
}

/** Every message shape that may cross the window boundary. */
export type OAuthRelayMessage = OAuthCodeMessage | OAuthErrorMessage;

/**
 * The authorization outcome to deliver. Discriminated and closed over primitive
 * fields only, so no caller can widen what reaches the relying party.
 */
export type OAuthResult =
  | { kind: 'code'; code: string; state: string | null }
  | {
      kind: 'error';
      error: string;
      errorDescription?: string;
      state: string | null;
    };

/** How a result was delivered. */
export type OAuthDelivery =
  | { mode: 'web_message'; message: OAuthRelayMessage; targetOrigin: string }
  | { mode: 'redirect'; url: string };

/** The opener surface used for web-message delivery. */
export interface WebMessageTarget {
  postMessage(message: OAuthRelayMessage, targetOrigin: string): void;
}

/**
 * The minimal `window` surface delivery needs. Injected rather than reached for
 * globally so the transport decision is testable without a browser.
 */
export interface DeliveryWindow {
  readonly opener: unknown;
  readonly location: { href: string };
  close(): void;
}

/** A resolved web-message destination. */
export interface ResolvedWebMessageTarget {
  target: WebMessageTarget;
  targetOrigin: string;
}

function isWebMessageTarget(value: unknown): value is WebMessageTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { postMessage?: unknown }).postMessage === 'function'
  );
}

/**
 * The exact `postMessage` target origin for a validated redirect URI, or null
 * when the URI has no web origin (native schemes serialize to the opaque
 * `"null"` origin and can never receive a web message).
 */
export function webMessageTargetOrigin(safeRedirectUri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(safeRedirectUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  const origin = parsed.origin;
  if (!origin || origin === 'null') return null;
  return origin;
}

/**
 * Resolve the web-message destination for this request, or null when the result
 * must be delivered by redirect instead. Requires ALL of: the relying party
 * asked for `response_mode=web_message`, a real opener window that is not this
 * window, and a redirect URI with a usable web origin.
 */
export function resolveWebMessageTarget(input: {
  responseMode: string | null;
  safeRedirectUri: string;
  window: DeliveryWindow;
}): ResolvedWebMessageTarget | null {
  if (input.responseMode !== WEB_MESSAGE_RESPONSE_MODE) return null;

  const opener = input.window.opener;
  if (!opener || opener === input.window) return null;
  if (!isWebMessageTarget(opener)) return null;

  const targetOrigin = webMessageTargetOrigin(input.safeRedirectUri);
  if (!targetOrigin) return null;

  return { target: opener, targetOrigin };
}

/**
 * Build the message for a result. Constructed field by field so the payload can
 * only ever contain the contract's fields — nothing from the surrounding
 * session can be spread in.
 */
export function buildRelayMessage(result: OAuthResult): OAuthRelayMessage {
  if (result.kind === 'code') {
    return {
      type: OAUTH_CODE_MESSAGE_TYPE,
      code: result.code,
      state: result.state ?? '',
    };
  }

  const message: OAuthErrorMessage = {
    type: OAUTH_ERROR_MESSAGE_TYPE,
    error: result.error,
  };
  if (result.errorDescription) {
    message.errorDescription = result.errorDescription;
  }
  if (result.state) {
    message.state = result.state;
  }
  return message;
}

/** Build the top-level redirect URL for a result. */
export function buildOAuthRedirectUrl(result: OAuthResult, safeRedirectUri: string): string {
  const url = new URL(safeRedirectUri);
  if (result.kind === 'code') {
    url.searchParams.set('code', result.code);
  } else {
    url.searchParams.set('error', result.error);
    if (result.errorDescription) {
      url.searchParams.set('error_description', result.errorDescription);
    }
  }
  if (result.state) {
    url.searchParams.set('state', result.state);
  }
  return url.toString();
}

/**
 * Deliver an authorization result to the relying party and report which
 * transport was used.
 *
 * Web message: posts to the opener at the redirect URI's exact origin, then
 * closes this window. A browser that refuses the close leaves the caller to
 * render a terminal "you can close this window" state — the result is already
 * delivered either way.
 *
 * Redirect: navigates this window to the redirect URI with the result in the
 * query string.
 */
export function deliverOAuthResult(input: {
  result: OAuthResult;
  safeRedirectUri: string;
  responseMode: string | null;
  window: DeliveryWindow;
}): OAuthDelivery {
  const relay = resolveWebMessageTarget({
    responseMode: input.responseMode,
    safeRedirectUri: input.safeRedirectUri,
    window: input.window,
  });

  if (relay) {
    const message = buildRelayMessage(input.result);
    relay.target.postMessage(message, relay.targetOrigin);
    try {
      input.window.close();
    } catch {
      // A window the browser refuses to close is not a delivery failure: the
      // message is already posted. The caller's terminal state stays on screen
      // so the user is told they can close it themselves.
    }
    return { mode: 'web_message', message, targetOrigin: relay.targetOrigin };
  }

  const url = buildOAuthRedirectUrl(input.result, input.safeRedirectUri);
  input.window.location.href = url;
  return { mode: 'redirect', url };
}
