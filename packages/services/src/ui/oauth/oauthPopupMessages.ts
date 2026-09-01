/**
 * Runtime validation for the popup OAuth `postMessage` channel.
 *
 * Everything arriving on `window`'s `message` event is untrusted: any frame on
 * the page, any other popup, and any browser extension can post to us. This
 * module is the ONLY place that decides whether an incoming event is a genuine
 * authorization response, and it answers with a value — never a thrown error.
 *
 * A message is accepted only when ALL of these hold:
 *   1. `event.origin` is EXACTLY the authorize endpoint's origin,
 *   2. `event.source` is the exact `Window` reference we opened,
 *   3. `event.data` matches one of the two frozen message shapes,
 *   4. the `state` it carries matches the one this RP sent.
 *
 * Failing (1)–(3) is indistinguishable from unrelated page traffic, so the
 * message is IGNORED and the flow keeps waiting. Failing (4) means our own
 * popup answered a different request than the one in flight, which is terminal:
 * it is reported as a mismatch rather than left to hang until the timeout.
 */

import { logger } from '@oxyhq/core';
import type { OAuthPopupHandle, OxyOAuthMessage } from './types';

/** `postMessage` discriminator for a successful authorization. */
export const OXY_OAUTH_CODE_MESSAGE_TYPE = 'oxy:oauth:code';

/** `postMessage` discriminator for a typed OAuth failure. */
export const OXY_OAUTH_ERROR_MESSAGE_TYPE = 'oxy:oauth:error';

/** Verdict for one incoming `message` event. */
export type OAuthPopupMessageVerdict =
  /** Not ours (wrong origin/source) or not a valid message — keep waiting. */
  | { kind: 'ignore' }
  | { kind: 'code'; code: string; state: string }
  | { kind: 'oauth-error'; error: string; errorDescription?: string }
  /** Well-formed, from our popup, but bound to a different authorize request. */
  | { kind: 'state-mismatch' };

/** What {@link readOAuthPopupMessage} validates an event against. */
export interface OAuthPopupMessageContext {
  /** Exact origin of the authorize endpoint (`new URL(authorizeUrl).origin`). */
  expectedOrigin: string;
  /** The CSRF `state` this RP sent on the authorize request. */
  expectedState: string;
  /** The exact popup reference `window.open()` returned. */
  popup: OAuthPopupHandle;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Reference equality across two `unknown` values.
 *
 * `event.source` is a `WindowProxy` and {@link OAuthPopupHandle} is a narrow
 * structural type, so comparing them directly is a type error. Widening both to
 * `unknown` keeps the check a plain identity comparison — which is exactly the
 * security property we want — without a cast.
 */
function isSameWindowReference(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * Parse untrusted `event.data` into one of the two frozen message shapes, or
 * `null` when it is anything else (including `null`, primitives, arrays, and
 * objects with missing/wrong-typed fields).
 *
 * Unknown extra properties are tolerated but never read: only the fields below
 * are ever surfaced, so a hostile sender cannot smuggle values past this point.
 */
export function parseOAuthPopupMessage(data: unknown): OxyOAuthMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  if (record.type === OXY_OAUTH_CODE_MESSAGE_TYPE) {
    if (!isNonEmptyString(record.code) || !isNonEmptyString(record.state)) return null;
    return { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: record.code, state: record.state };
  }

  if (record.type === OXY_OAUTH_ERROR_MESSAGE_TYPE) {
    if (!isNonEmptyString(record.error)) return null;
    return {
      type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
      error: record.error,
      ...(isNonEmptyString(record.errorDescription)
        ? { errorDescription: record.errorDescription }
        : {}),
      ...(isNonEmptyString(record.state) ? { state: record.state } : {}),
    };
  }

  return null;
}

/**
 * Classify one `message` event against the in-flight authorize request.
 *
 * Never throws. See the module header for the acceptance rules.
 */
export function readOAuthPopupMessage(
  event: MessageEvent,
  context: OAuthPopupMessageContext,
): OAuthPopupMessageVerdict {
  // These two are a PAIR, and the source check is load-bearing rather than
  // belt-and-braces. `expectedOrigin` is `new URL(authorizeUrl).origin`, and
  // `authorizeBaseUrl` is app-configurable — a non-http(s) value makes that
  // expression the literal string `"null"`, the opaque origin, which is also
  // what a browser reports as `event.origin` for EVERY sandboxed iframe,
  // `data:` document and `file:` page. The origin check stops discriminating at
  // that point and the source check is the only thing still refusing them.
  // Do not collapse them into one, and do not drop the source check as
  // redundant with the origin check: it is not, in the one case that matters.
  if (event.origin !== context.expectedOrigin) return { kind: 'ignore' };
  if (!isSameWindowReference(event.source, context.popup)) return { kind: 'ignore' };

  const message = parseOAuthPopupMessage(event.data);
  if (!message) {
    // Origin and source matched, so this came from the IdP window we opened —
    // a shape we cannot read is worth a breadcrumb, unlike ordinary page noise.
    logger.debug(
      'Ignored an unrecognised message from the OAuth popup',
      { component: 'oauthPopupMessages' },
    );
    return { kind: 'ignore' };
  }

  if (message.type === OXY_OAUTH_CODE_MESSAGE_TYPE) {
    if (message.state !== context.expectedState) return { kind: 'state-mismatch' };
    return { kind: 'code', code: message.code, state: message.state };
  }

  // An error MAY carry `state` (the IdP omits it when the request never got far
  // enough to bind one). When present it must match: a foreign error must not be
  // able to end an unrelated in-flight sign-in.
  if (message.state !== undefined && message.state !== context.expectedState) {
    return { kind: 'state-mismatch' };
  }
  return {
    kind: 'oauth-error',
    error: message.error,
    ...(message.errorDescription ? { errorDescription: message.errorDescription } : {}),
  };
}
