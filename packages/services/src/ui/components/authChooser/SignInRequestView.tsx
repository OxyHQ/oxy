/**
 * The ACTIVE REQUEST surface (`qr` view) as the account dialog drives it —
 * `AccountDialogController`'s device flow bound to the shared, presentational
 * {@link OxySignInRequestSurface} (issue #691, Phase 5).
 *
 * This module owns WIRING only. Every pixel comes from the shared surface, which
 * the auth.oxy.so IdP mounts from its own OAuth-bound request; there is one
 * implementation of the request presentation, not two. What lives here is what
 * only the account dialog knows:
 *
 *  - which of the controller's facts map onto the surface's props;
 *  - which alternatives are genuine ones for the CURRENT presentation (the
 *    passkey ceremony is pointless once the request is already being confirmed,
 *    and a QR link is redundant while the QR itself is the primary visual);
 *  - the one piece of local intent the controller has no opinion on: leaving the
 *    acquisition surface via "I have Commons on another device".
 *
 * Failures are NOT rendered here. The container toasts them at the point they
 * arrive (owner mandate: no error renders inline inside the dialog); this view
 * only reports that the request failed, so the surface can offer "Try again".
 */

import type React from 'react';
import { useState } from 'react';
import type { AccountDialogSnapshot } from '@oxyhq/core';
import OxySignInRequestSurface from '../OxySignInRequestSurface';
import type { OxySignInSurfaceAction, SignInAlternatives, Translate } from './types';

interface SignInRequestViewProps {
  snapshot: AccountDialogSnapshot;
  t: Translate;
  /** Restart the request after a failure. */
  onRetry: () => void;
  alternatives: SignInAlternatives;
}

const SignInRequestView: React.FC<SignInRequestViewProps> = ({
  snapshot,
  t,
  onRetry,
  alternatives,
}) => {
  const { signIn, commonsAvailability } = snapshot;
  // Set only from the disclosure's own "I have Commons on another device" —
  // an explicit user choice to leave the acquisition surface, never inferred.
  const [qrRequested, setQrRequested] = useState(false);

  const failed = signIn.phase === 'error';
  // A same-device QR is a dead end without Commons, so the acquisition surface
  // leads — until the user explicitly asks for the QR anyway.
  const acquiring = !failed && commonsAvailability === 'unavailable' && !qrRequested;

  // A ceremony is pointless once the request is already being confirmed, and a
  // ceremony FAILURE is toasted by the container — this link never renders an
  // error of its own (owner mandate).
  const passkeyAction: OxySignInSurfaceAction[] =
    alternatives.passkeyAvailable && signIn.phase !== 'authorized' && signIn.phase !== 'completed'
      ? [
          {
            key: 'passkey-signin-link',
            label: alternatives.passkeyPending
              ? t('accountSwitcher.passkeySigningIn')
              : t('accountSwitcher.useIdentityOnDevice'),
            onPress: alternatives.onSignInWithPasskey,
            disabled: alternatives.passkeyPending,
          },
        ]
      : [];

  const troubleActions = ((): OxySignInSurfaceAction[] => {
    // Nothing about the chosen route is actionable any more — only the
    // authentication alternatives are.
    if (failed) return passkeyAction;
    if (acquiring) {
      return [
        {
          key: 'show-qr-anyway-link',
          label: t('accountSwitcher.showQrAnyway'),
          onPress: () => setQrRequested(true),
        },
        ...passkeyAction,
      ];
    }
    return [
      // Redundant while the QR already IS the primary surface.
      ...(signIn.route === 'qr'
        ? []
        : [
            {
              key: 'scan-qr-link',
              label: t('accountSwitcher.scanQr'),
              onPress: alternatives.onShowQr,
            },
          ]),
      ...passkeyAction,
      {
        key: 'get-commons-link',
        label: t('accountSwitcher.getCommons'),
        onPress: alternatives.onGetCommons,
      },
    ];
  })();

  return (
    <OxySignInRequestSurface
      route={signIn.route}
      progress={signIn.progress}
      qrPayload={signIn.qrPayload}
      routeFailed={signIn.routeFailed}
      failed={failed}
      onRetry={onRetry}
      onAcquireCommons={acquiring ? alternatives.onGetCommons : undefined}
      subordinate={[
        // Account CREATION is not an authentication method, and on web this
        // surface is the FIRST one a signed-out user sees (the entry auto-starts
        // straight through it) — so the way in for someone with no Oxy ID stays
        // visible as a subordinate link rather than hiding behind a
        // troubleshooting affordance.
        {
          key: 'create-account-link',
          label: t('signin.createAccountLink'),
          onPress: alternatives.onCreateAccount,
        },
      ]}
      alternatives={troubleActions}
    />
  );
};

export default SignInRequestView;
