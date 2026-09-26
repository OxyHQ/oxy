/**
 * The browser bridge, the app half (ADR 0029 D2).
 *
 * Different domains share no storage, so the browser's ONE Oxy session lives on
 * auth.oxy.so. The first time a person presses sign-in in an Oxy web app that
 * holds no device credential, the app opens `auth.oxy.so/bridge` from that press:
 * a page with no UI that proves (or registers) auth.oxy.so's device, posts this
 * app a one-use code bound to its client id, its exact redirect URI and a PKCE
 * challenge, and closes. The app redeems the code with the verifier only it
 * holds (`POST /session/device/join`) and from then on holds its own credential
 * on the shared device — it never opens the bridge again.
 *
 * Three browser realities, the same ones as the OAuth popup (`oauthPopup.ts`):
 * the window must be opened SYNCHRONOUSLY from the press (gesture attribution),
 * so it is opened empty and navigated once the PKCE pair exists; a cross-origin
 * window fires nothing when it closes, so `closed` is polled; and its result
 * arrives only as a `postMessage`, accepted from the auth origin and from that
 * exact window, carrying this attempt's `state`.
 *
 * Nothing here is required for signing in: a blocked window, a timeout or any
 * failure only means this app signs in on a device of its own, as before.
 */

import { AUTH_WEB_ORIGIN, generateOAuthState, generatePkcePair, logger } from '@oxy.so/core';
import type { OxyServices } from '@oxy.so/core';
import type { OAuthPopupHandle } from './types';

/** `postMessage` discriminator for a join code from the bridge. */
export const OXY_BRIDGE_CODE_MESSAGE_TYPE = 'oxy:bridge:code';
/** `postMessage` discriminator for a bridge that could not produce a code. */
export const OXY_BRIDGE_ERROR_MESSAGE_TYPE = 'oxy:bridge:error';

/** Its own name, so it never reuses (and navigates away) the sign-in popup. */
export const OXY_BRIDGE_WINDOW_NAME = 'oxy-bridge';

/**
 * How long the bridge may take (ms). It normally answers in a few hundred ms; the
 * ceiling only stops a wedged window from holding the attempt open.
 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000;

const CLOSE_POLL_INTERVAL_MS = 250;
const CLOSE_GRACE_MS = 300;

/** The auth origin the bridge lives on: the authorize override's, else auth.oxy.so. */
export function resolveBridgeOrigin(authorizeBaseUrl?: string): string | null {
  if (!authorizeBaseUrl) return AUTH_WEB_ORIGIN;
  try {
    const origin = new URL(authorizeBaseUrl).origin;
    return origin.startsWith('http') ? origin : null;
  } catch {
    return null;
  }
}

interface BridgeHost {
  open?: (url: string, target: string, features: string) => OAuthPopupHandle | null;
  addEventListener?: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: MessageEvent) => void) => void;
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
}

function bridgeHost(): BridgeHost | null {
  const win = (globalThis as { window?: BridgeHost }).window;
  return win ?? null;
}

/**
 * Open the bridge window, EMPTY, as small as the browser allows and centred over
 * the app. MUST be called synchronously from the press. Returns `null` when the
 * browser blocked it or there is no DOM — never throws.
 */
export function openBridgeWindow(): OAuthPopupHandle | null {
  const win = bridgeHost();
  if (!win || typeof win.open !== 'function') return null;
  const left = Math.round((win.screenX ?? 0) + (win.outerWidth ?? 0) / 2);
  const top = Math.round((win.screenY ?? 0) + (win.outerHeight ?? 0) / 2);
  const features = `popup=yes,width=1,height=1,left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`;
  try {
    return win.open('', OXY_BRIDGE_WINDOW_NAME, features) ?? null;
  } catch (error) {
    logger.debug('Could not open the browser bridge window', { component: 'browserBridge' }, error);
    return null;
  }
}

function closeBridgeWindow(popup: OAuthPopupHandle): void {
  try {
    if (!popup.closed) popup.close();
  } catch {
    // Already gone.
  }
}

/** The fields of a `message` event the verdict reads. */
interface BridgeMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/** Verdict for one `message` event. */
export type BridgeMessageVerdict =
  | { kind: 'ignore' }
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string };

/**
 * Classify one `message` event. Accepted only from the bridge origin AND the
 * exact window this attempt opened, in one of the two shapes, with this
 * attempt's `state`; everything else is page noise and ignored.
 */
export function readBridgeMessage(
  event: BridgeMessageEvent,
  context: { expectedOrigin: string; expectedState: string; popup: unknown },
): BridgeMessageVerdict {
  if (event.origin !== context.expectedOrigin) return { kind: 'ignore' };
  if (event.source !== context.popup) return { kind: 'ignore' };
  const data = event.data as Record<string, unknown> | null;
  if (typeof data !== 'object' || data === null) return { kind: 'ignore' };
  if (data.state !== context.expectedState) return { kind: 'ignore' };
  if (data.type === OXY_BRIDGE_CODE_MESSAGE_TYPE && typeof data.code === 'string' && data.code.length > 0) {
    return { kind: 'code', code: data.code };
  }
  if (data.type === OXY_BRIDGE_ERROR_MESSAGE_TYPE && typeof data.error === 'string') {
    return { kind: 'error', error: data.error };
  }
  return { kind: 'ignore' };
}

export interface RunBrowserBridgeOptions {
  /** The window {@link openBridgeWindow} returned from the press. */
  popup: OAuthPopupHandle;
  /** Where the bridge lives ({@link resolveBridgeOrigin}). */
  bridgeOrigin: string;
  oxyServices: OxyServices;
  /** This app's registered client id. */
  clientId: string;
  /** This app's EXACT registered redirect URI; its origin is where the code is posted. */
  redirectUri: string;
  /** @default DEFAULT_BRIDGE_TIMEOUT_MS */
  timeoutMs?: number;
}

export type BrowserBridgeResult =
  | { ok: true; deviceId: string; deviceSecret: string }
  | { ok: false; reason: 'closed' | 'timed-out' | 'bridge-error' | 'join-failed' | 'no-browser' };

/**
 * Drive an opened bridge window to a device credential for this app. Settles
 * exactly once, closes the window whatever the outcome, and never rejects.
 */
export async function runBrowserBridge(options: RunBrowserBridgeOptions): Promise<BrowserBridgeResult> {
  const { popup, bridgeOrigin, oxyServices, clientId, redirectUri } = options;
  const host = bridgeHost();
  if (!host || typeof host.addEventListener !== 'function' || typeof host.removeEventListener !== 'function') {
    closeBridgeWindow(popup);
    return { ok: false, reason: 'no-browser' };
  }
  try {
    const [pkce, state] = await Promise.all([generatePkcePair(), generateOAuthState()]);
    const url = new URL('/bridge', bridgeOrigin);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    try {
      popup.location.href = url.toString();
    } catch {
      return { ok: false, reason: 'closed' };
    }

    const verdict = await awaitBridgeMessage(host, {
      popup,
      expectedOrigin: bridgeOrigin,
      expectedState: state,
      timeoutMs: options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
    });
    if (verdict.kind !== 'code') return { ok: false, reason: verdict.kind };

    try {
      const joined = await oxyServices.devices.joinBrowser({
        code: verdict.code,
        codeVerifier: pkce.codeVerifier,
        clientId,
        redirectUri,
      });
      return { ok: true, deviceId: joined.deviceId, deviceSecret: joined.deviceSecret };
    } catch (error) {
      logger.warn('Joining the browser device failed', { component: 'browserBridge' }, error);
      return { ok: false, reason: 'join-failed' };
    }
  } catch (error) {
    logger.warn('The browser bridge failed', { component: 'browserBridge' }, error);
    return { ok: false, reason: 'bridge-error' };
  } finally {
    closeBridgeWindow(popup);
  }
}

function awaitBridgeMessage(
  host: BridgeHost,
  context: { popup: OAuthPopupHandle; expectedOrigin: string; expectedState: string; timeoutMs: number },
): Promise<{ kind: 'code'; code: string } | { kind: 'closed' | 'timed-out' | 'bridge-error' }> {
  return new Promise((resolve) => {
    let settled = false;
    let closeGrace: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (event: MessageEvent): void => {
      const verdict = readBridgeMessage(event, context);
      if (verdict.kind === 'code') settle({ kind: 'code', code: verdict.code });
      else if (verdict.kind === 'error') settle({ kind: 'bridge-error' });
    };
    const timeout = setTimeout(() => settle({ kind: 'timed-out' }), context.timeoutMs);
    const poll = setInterval(() => {
      if (!context.popup.closed || closeGrace !== null) return;
      // The bridge posts and THEN closes; let an already-queued message win.
      closeGrace = setTimeout(() => settle({ kind: 'closed' }), CLOSE_GRACE_MS);
    }, CLOSE_POLL_INTERVAL_MS);
    function settle(outcome: { kind: 'code'; code: string } | { kind: 'closed' | 'timed-out' | 'bridge-error' }): void {
      if (settled) return;
      settled = true;
      host.removeEventListener?.('message', onMessage);
      clearTimeout(timeout);
      clearInterval(poll);
      if (closeGrace !== null) clearTimeout(closeGrace);
      resolve(outcome);
    }
    host.addEventListener?.('message', onMessage);
  });
}
