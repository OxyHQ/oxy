/**
 * `OxySignInRequestSurface` — the in-flight "Sign in with Oxy" request, rendered
 * from plain facts (issue #691, Phase 5).
 *
 * The user already performed their one action. From here the surface only
 * REPORTS: the route-appropriate primary visual, the status line for the
 * progress it was told about, and nothing else at the same weight. Alternatives
 * stay behind "Having trouble?" until the chosen route could not be carried out,
 * at which point they ARE the content and render plainly.
 *
 * PRESENTATIONAL AND HEADLESS-FRIENDLY. It owns no request, no controller, no
 * polling, and no state of its own: everything it draws is a prop. That is what
 * lets the two hosts of this surface share ONE implementation —
 *
 *  - `OxyAuthChooser`'s `SignInRequestView`, driven by `AccountDialogController`'s
 *    device flow;
 *  - the auth.oxy.so IdP's OAuth-bound lane, whose request carries an OAuth
 *    binding the account dialog's session has no concept of.
 *
 * It resolves only what every `@oxyhq/services` consumer already has in context:
 * the Bloom theme (`useTheme`) and the SDK's own locale dictionary (`useI18n`,
 * the `accountSwitcher.*` copy in all 11 locales). Host-specific copy — the
 * labels on {@link OxySignInRequestSurfaceProps.subordinate} and
 * {@link OxySignInRequestSurfaceProps.alternatives} — arrives already localized.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *  - it renders no failure REASON. A host surfaces that the way its own shell
 *    demands (the account dialog toasts it — errors never render inline there;
 *    a full page may show a banner around this surface). The surface only takes
 *    the fact that the request failed, and offers the way forward.
 *  - it derives nothing from {@link OxySignInRequestSurfaceProps.qrPayload}.
 *    Application identity, origin, and scopes are resolved server-side by the
 *    approver (Commons), never read out of a payload here — the plate encodes it
 *    and shows nothing about it.
 *
 * SECRETS: every prop is safe to render. There is no `sessionToken` (the secret
 * claim/finalize credential), no bearer, and no authorization code — a host
 * keeps those in its own controller, and no prop on this component invites one.
 */

import type React from 'react';
import { View } from 'react-native';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import type { CommonsDeliveryRoute, SignInProgress } from '@oxyhq/core';
import { useI18n } from '../hooks/useI18n';
import TroubleDisclosure from './authChooser/TroubleDisclosure';
import { SubtleLink } from './authChooser/primitives';
import { GetCommonsPrompt, RequestPrimarySurface } from './authChooser/requestSurfaces';
import { signInProgressLabel } from './authChooser/signInProgress';
import { authChooserStyles as styles } from './authChooser/styles';
import type { OxySignInSurfaceAction } from './authChooser/types';

/** Shared empty list, so an omitted action bundle allocates nothing per render. */
const NO_ACTIONS: readonly OxySignInSurfaceAction[] = [];

export interface OxySignInRequestSurfaceProps {
  /**
   * The ONE primary delivery route chosen for this request, or `null` while it
   * is still being resolved. There is no chain: the surface renders exactly one
   * route's visual, and never guesses one that has not been chosen yet.
   */
  route: CommonsDeliveryRoute | null;
  /**
   * The request's DERIVED progress — the only thing the status line is built
   * from. It must come from a real observed signal (a server-reported delivery,
   * an approver opening the request, an approval); the surface owns no clock and
   * will never advance it on its own. `'idle'` means there is nothing honest to
   * report, and renders no status line.
   */
  progress: SignInProgress;
  /**
   * The PUBLIC `oxycommons://approve?…` payload to encode as the QR, or `null`.
   * It carries the single-use approval handle — never a secret credential — and
   * the surface renders NOTHING derived from it.
   */
  qrPayload?: string | null;
  /**
   * `true` when the chosen primary route could not be carried out on this device.
   * The one signal that reveals {@link alternatives} without the user asking;
   * a host never silently cascades to another route on its own.
   */
  routeFailed?: boolean;
  /**
   * `true` when the request itself is terminally failed — there is no working
   * primary route left to report on, so {@link onRetry} becomes the surface's one
   * primary action and the alternatives render plainly.
   */
  failed?: boolean;
  /**
   * Start a BRAND-NEW request. Rendered as the primary action while
   * {@link failed}; omit it when a fresh attempt cannot help (a request that
   * would fail identically every time), leaving the alternatives as the only
   * way forward.
   */
  onRetry?: () => void;
  /**
   * The acquisition action for a device where Commons is known to be ABSENT.
   *
   * Pass it ONLY on a positive "not installed" verdict. There, acquiring Commons
   * is the GENUINE primary route — a same-device QR the user would have to scan
   * with the very screen showing it is a dead end — so the surface leads with it
   * and reports no route progress. Omit it wherever absence cannot be known (a
   * browser cannot ask whether a URL scheme is registered).
   */
  onAcquireCommons?: () => void;
  /**
   * Subordinate links rendered directly beneath the primary, always visible:
   * the ways OUT of the surface that are not troubleshooting (creating an
   * account, cancelling the request).
   */
  subordinate?: readonly OxySignInSurfaceAction[];
  /**
   * The alternative ways to authenticate, kept behind "Having trouble?" until
   * the user asks — or shown plainly once {@link failed} / {@link routeFailed}
   * says the chosen route cannot deliver.
   */
  alternatives?: readonly OxySignInSurfaceAction[];
}

export const OxySignInRequestSurface: React.FC<OxySignInRequestSurfaceProps> = ({
  route,
  progress,
  qrPayload = null,
  routeFailed = false,
  failed = false,
  onRetry,
  onAcquireCommons,
  subordinate = NO_ACTIONS,
  alternatives = NO_ACTIONS,
}) => {
  const theme = useTheme();
  const { t } = useI18n();

  const subordinateLinks = subordinate.map((action) => (
    <SubtleLink
      key={action.key}
      label={action.label}
      theme={theme}
      onPress={action.onPress}
      disabled={action.disabled}
      testID={action.key}
    />
  ));

  // A failed request has no working primary route left. Its REASON is the host's
  // to surface (toast / banner); all this owes the user is the way forward.
  if (failed) {
    return (
      <View style={styles.centeredBlock}>
        {onRetry ? (
          <Button variant="primary" onPress={onRetry} style={styles.primaryButton}>
            {t('common.actions.tryAgain')}
          </Button>
        ) : null}
        {subordinateLinks}
        <TroubleDisclosure actions={alternatives} revealed theme={theme} t={t} />
      </View>
    );
  }

  // Commons is absent: acquiring it IS the primary route, not a fallback, so it
  // renders as the one primary action and no route progress is reported (there is
  // no route to report on until the host says otherwise).
  if (onAcquireCommons) {
    return (
      <View style={styles.centeredBlock}>
        <GetCommonsPrompt theme={theme} t={t} onGetCommons={onAcquireCommons} />
        {subordinateLinks}
        <TroubleDisclosure actions={alternatives} revealed={false} theme={theme} t={t} />
      </View>
    );
  }

  const status = signInProgressLabel(progress, route, t);

  return (
    <View style={styles.centeredBlock}>
      <RequestPrimarySurface
        route={route}
        progress={progress}
        qrPayload={qrPayload}
        theme={theme}
        t={t}
      />
      {status ? (
        <Text
          style={[styles.mutedText, { color: theme.colors.textSecondary }]}
          accessibilityLiveRegion="polite"
          testID="signin-progress"
        >
          {status}
        </Text>
      ) : null}
      {subordinateLinks}
      <TroubleDisclosure actions={alternatives} revealed={routeFailed} theme={theme} t={t} />
    </View>
  );
};

export default OxySignInRequestSurface;
