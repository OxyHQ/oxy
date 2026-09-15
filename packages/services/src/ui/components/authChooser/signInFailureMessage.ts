/**
 * The localized toast for a failed sign-in attempt.
 *
 * One responsibility: turn the controller's machine-readable
 * `signIn.failure` into copy. The controller ships no user-facing prose — its
 * raw `signIn.error` is English or a server string, kept for diagnostics only.
 */

import type { SignInFailureReason } from '@oxy.so/core';
import type { Translate } from './types';

/**
 * The toast for `failure`, or `null` when there is nothing to report: a
 * `'cancelled'` attempt is the user's own choice (they closed the window), and
 * the surface already offers "Try again" without scolding them for it.
 */
export function signInFailureMessage(
  failure: SignInFailureReason | null,
  t: Translate,
): string | null {
  switch (failure) {
    case 'cancelled':
      return null;
    case 'denied':
      return t('accountSwitcher.signInFailures.denied');
    case 'expired':
      return t('accountSwitcher.signInFailures.expired');
    case 'network':
      return t('accountSwitcher.signInFailures.network');
    case 'not-configured':
      return t('accountSwitcher.signInFailures.notConfigured');
    case 'unsupported-flow':
      return t('accountSwitcher.signInFailures.unsupportedFlow');
    case 'claim-failed':
      return t('accountSwitcher.signInFailures.claimFailed');
    default:
      return t('accountSwitcher.signInFailures.generic');
  }
}
