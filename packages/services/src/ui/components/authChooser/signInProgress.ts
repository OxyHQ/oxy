/**
 * The sign-in status line's copy (issue #691, Phase 5).
 *
 * One responsibility: map the controller's DERIVED `signIn.progress` — plus the
 * chosen route, which only disambiguates the generic waiting step — onto a
 * sentence. Pure and total, with no clock and no state of its own: the line can
 * therefore only advance when the controller observed a real signal, never on a
 * timer and never optimistically.
 *
 * The ladder the user sees:
 *
 *     Preparing request
 *     Check Commons on your phone
 *     Opened in Commons
 *     Confirming identity
 *     Identity confirmed
 */

import type { CommonsDeliveryRoute, SignInProgress } from '@oxyhq/core';
import type { Translate } from './types';

/**
 * The status sentence for the active request, or `null` when there is nothing
 * honest to say (no live request, or a terminal error — which is toasted, never
 * rendered inline).
 */
export function signInProgressLabel(
  progress: SignInProgress,
  route: CommonsDeliveryRoute | null,
  t: Translate,
): string | null {
  switch (progress) {
    case 'idle':
      return null;
    case 'preparing':
      return t('accountSwitcher.progress.preparing');
    case 'awaiting-approval':
      // The only step whose copy depends on the route: waiting means something
      // different when the user is holding a QR than when Commons was opened
      // for them. `await-push` never reaches here — a chosen push route is
      // itself a confirmed dispatch, so it derives to `delivered-to-commons`.
      if (route === 'qr') return t('accountSwitcher.progress.scanWithCommons');
      if (route === 'open-commons') return t('accountSwitcher.progress.continueInCommons');
      return t('accountSwitcher.progress.awaitingApproval');
    case 'delivered-to-commons':
      return t('accountSwitcher.progress.checkCommons');
    case 'opened-in-commons':
      return t('accountSwitcher.progress.openedInCommons');
    case 'confirming-identity':
      return t('accountSwitcher.progress.confirming');
    case 'identity-confirmed':
      return t('accountSwitcher.progress.confirmed');
    default: {
      const _exhaustive: never = progress;
      return _exhaustive;
    }
  }
}
