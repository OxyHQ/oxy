/**
 * The ONE path from an OAuth authorization code to a committed session.
 *
 * Both web transports end here — the popup with an in-memory handshake, the
 * redirect lane with one read back from `sessionStorage` — so state validation,
 * the PKCE exchange, the session commit, and handshake cleanup exist exactly
 * once. Duplicating any of those per transport is how the two lanes would drift
 * apart on the security-critical steps.
 *
 * Ordering is deliberate and load-bearing:
 *   1. validate `state` BEFORE anything is sent to the token endpoint,
 *   2. exchange the code for a session,
 *   3. run `cleanup` (drop the persisted handshake / strip `?code=` from the
 *      URL) BEFORE the commit, so a stale code can never re-enter the exchange,
 *   4. commit the session.
 *
 * `cleanup` runs exactly once on EVERY exit path, including a state mismatch
 * and a failed exchange.
 */

import type { OxyServices } from '@oxy.so/core';
import { logger } from '@oxy.so/core';
import type { OAuthCompletionResult, OAuthHandshake, OAuthSessionCommitInput } from './types';

/** Inputs for {@link completeOAuthCode}. */
export interface CompleteOAuthCodeInput {
  oxyServices: OxyServices;
  /** The registered `ApplicationCredential` public key (`oxy_dk_…`). */
  clientId: string;
  /** The single-use authorization code the IdP issued. */
  code: string;
  /** The `state` the IdP returned, or `null` when it sent none. */
  returnedState: string | null;
  /**
   * The handshake this RP started the authorize request with, or `null` when it
   * is gone (never stored, expired, or a different tab's). A missing handshake
   * is treated exactly like a mismatched `state`: no exchange is attempted.
   */
  handshake: OAuthHandshake | null;
  /** EXACT redirect URI sent on the authorize request — OAuth requires a match. */
  redirectUri: string;
  /** The provider's session commit funnel. */
  commitSession: (input: OAuthSessionCommitInput) => Promise<void>;
  /**
   * Transport-specific teardown, invoked once after the exchange settles and
   * before the commit. The redirect lane strips `?code=` and clears the
   * persisted handshake; the popup lane has nothing persisted and omits it.
   */
  cleanup?: () => void;
}

export async function completeOAuthCode(
  input: CompleteOAuthCodeInput,
): Promise<OAuthCompletionResult> {
  let cleaned = false;
  const runCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    input.cleanup?.();
  };

  if (!input.handshake || !input.returnedState || input.handshake.state !== input.returnedState) {
    logger.warn('OAuth completion rejected: missing or mismatched state', {
      component: 'completeOAuthCode',
    });
    runCleanup();
    return { ok: false, reason: 'state-mismatch' };
  }

  try {
    const result = await input.oxyServices.exchangeOAuthCode({
      code: input.code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: input.handshake.codeVerifier,
    });
    runCleanup();
    await input.commitSession({
      sessionId: result.sessionId,
      accessToken: result.accessToken,
      deviceId: result.deviceId,
      deviceSecret: result.deviceSecret,
      userId: result.user.id,
      expiresAt: result.expiresAt,
      user: result.user,
    });
    return { ok: true };
  } catch (error) {
    logger.warn('OAuth code exchange failed', { component: 'completeOAuthCode' }, error);
    runCleanup();
    return { ok: false, reason: 'exchange-failed' };
  }
}
