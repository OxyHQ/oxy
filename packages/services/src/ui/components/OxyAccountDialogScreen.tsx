/**
 * OxyAccountDialogScreen — the ONE unified account dialog BODY for `@oxyhq/services`.
 *
 * The header (title/subtitle per view + back button) around the headless chooser
 * logic, which lives in `OxyAuthChooser` — the account switcher, sign-in,
 * sign-up, and QR views are ALL there, extracted so the same chooser can be
 * mounted bare by a future host with no Dialog chrome (e.g. an auth.oxy.so hub
 * page driving the cross-origin passkey popup, b2). This file owns ONLY the
 * header + the scroll body.
 *
 * It is presented as the `AccountDialog` route on the shared Bloom SURFACE STACK
 * (`@oxyhq/bloom/surfaces`) — `OxyContext.openAccountDialog` calls
 * `presentDetached('AccountDialog', …, { placement: { base: 'bottom', md:
 * 'center' }, dismissOnBackdrop: false, maxWidth: 420 })`, so the STACK owns the
 * responsive `<Dialog>` chrome and this component renders only its content. That
 * replaces the previous standalone controlled `<Dialog open={isAccountDialogOpen}>`
 * mount: dismissal now flows through the stack (backdrop/swipe disabled), and the
 * header close button (and `OxyAuthChooser`'s `onComplete`) drive
 * `useOxy().closeAccountDialog`, which dismisses the surface and runs its exit
 * animation. The view-enum (`accounts|signin|qr|add|signup`) stays internal here,
 * driven by the shared `AccountDialogController` in `@oxyhq/core`.
 */

import type React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountDialogSnapshot } from '@oxyhq/core';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import type { BaseScreenProps } from '../types/navigation';
import LogoText from './logo/LogoText';
import OxyAuthChooser from './OxyAuthChooser';
import { EMPTY_ACCOUNT_DIALOG_SNAPSHOT } from '../hooks/accountDialogSnapshot';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * The account MENU's nav bar carries the Oxy wordmark instead of a title — the
 * surface IS the Oxy account, so naming it in prose is redundant. A module-level
 * element: it takes no props, so its identity is stable forever and the header's
 * identity-compared slot never thrashes.
 */
const NAV_LOGO = <LogoText height={20} />;

/**
 * The unified account dialog BODY — the header + `OxyAuthChooser` chooser.
 *
 * Presented as the `AccountDialog` surface (route) on the shared Bloom surface
 * stack; the surface owns the `<Dialog>` chrome (responsive `{ base: 'bottom',
 * md: 'center' }` placement, `dismissOnBackdrop={false}`, `maxWidth={420}` — set
 * by `OxyContext` when it presents this surface), so this component renders ONLY
 * the content. Open it via `useOxy().openAccountDialog(view?)` or the imperative
 * `openAccountDialog('signin')`; the view-enum (`accounts|signin|qr|add|signup`)
 * stays internal here, driven by the shared `AccountDialogController` in
 * `@oxyhq/core`. Closing routes through `useOxy().closeAccountDialog`, which
 * dismisses the surface and runs its exit animation.
 */
const OxyAccountDialogScreen: React.FC<BaseScreenProps> = ({ canGoBack }) => {
  const { accountDialogController: controller, closeAccountDialog } = useOxy();
  const { t } = useI18n();

  // A lightweight, header-only binding to the same controller `OxyAuthChooser`
  // binds independently — cheap, and the established pattern here (
  // `useSwitchableAccounts` also binds to this controller on its own).
  const subscribe = useCallback(
    (listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined),
    [controller],
  );
  const getSnapshot = useCallback(
    () => (controller ? controller.getSnapshot() : EMPTY_ACCOUNT_DIALOG_SNAPSHOT),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const { view } = snapshot;
  const showBack =
    view === 'qr' || view === 'signup' || (view === 'add' && snapshot.accounts.length > 0);
  const goToAccounts = useCallback(() => {
    if (!controller) return;
    const { view: currentView, signIn } = controller.getSnapshot();
    // Backing out of an active request must withdraw it — otherwise the
    // authorizeCode stays approvable until expiry (issue #691 phase 5).
    if (
      (currentView === 'qr' || currentView === 'add') &&
      (signIn.phase === 'starting' || signIn.phase === 'waiting')
    ) {
      controller.cancelSignIn();
    }
    controller.setView('accounts');
  }, [controller]);
  // An ENTRY view (accounts / signin — no in-dialog back of its own) that is
  // MORPHED into a host surface (ManageAccount → switcher) has a frame beneath it,
  // so its back CLOSES the dialog and reshapes back to the host — routed through
  // `closeAccountDialog` so the pop + state teardown stay in one place. Opened
  // cold (detached) it is the root frame → `canGoBack` is false → no back.
  const backsToHost = !showBack && (canGoBack?.() ?? false);
  // The account MENU is branded, not titled: its nav bar carries the Oxy
  // wordmark and no large title. The current account is named by the HERO block
  // `OxyAuthChooser` renders under it (email + large avatar + greeting), never
  // by the bar. Every OTHER view keeps the SHARED Dialog nav header the rest of
  // the SDK uses — a large in-content title/subtitle that collapses into the bar
  // on scroll — because their copy is informative.
  const copy = view === 'accounts' ? null : headerCopy(view, snapshot.accounts.length, t);

  useSurfaceHeader({
    titleContent: copy ? undefined : NAV_LOGO,
    title: copy?.title,
    subtitle: copy?.subtitle ?? undefined,
    onBack: showBack ? goToAccounts : backsToHost ? closeAccountDialog : undefined,
  });

  if (!controller) {
    return null;
  }

  return (
    <View style={styles.bodyContent}>
      <OxyAuthChooser onComplete={closeAccountDialog} />
    </View>
  );
};

// ---------------------------------------------------------------------------
// Copy + helpers
// ---------------------------------------------------------------------------

function headerCopy(
  view: Exclude<AccountDialogSnapshot['view'], 'accounts'>,
  accountCount: number,
  t: Translate,
): { title: string; subtitle: string | null } {
  switch (view) {
    // The ACTIVE REQUEST. Its header is deliberately route-AGNOSTIC: Oxy picks
    // the delivery route (QR here, a push to the user's phone, or opening
    // Commons on this device — issue #691), so naming one of them in the bar
    // would contradict the other two. The route-specific status line lives in
    // the body, derived from `signIn.progress`, and is the only thing that
    // describes HOW the request is travelling.
    case 'qr':
      return {
        title: t('accountSwitcher.signInWithOxy') || 'Sign in with Oxy',
        subtitle: null,
      };
    case 'signup':
      return {
        title: t('signup.title') || 'Create your account',
        subtitle: t('signup.subtitle') || 'One identity for the whole ecosystem.',
      };
    default:
      return accountCount > 0
        ? {
            title: t('signin.addAccountTitle') || 'Add another account',
            subtitle: t('signin.addAccountSubtitle') || 'Sign in with another account.',
          }
        : {
            title: t('signin.title') || 'Sign in',
            subtitle: t('signin.subtitle') || 'One identity for the whole ecosystem.',
          };
  }
}

/**
 * The screen gutter. In the Dialog's nav-header mode the surface adds NO content
 * padding of its own — the large title and each screen own theirs — so this must
 * match Bloom's own large-title gutter (`screen-margin`, 20px) for the body to
 * line up with the title above it.
 */
const SCREEN_MARGIN = 20;

const styles = StyleSheet.create({
  bodyContent: {
    paddingTop: 4,
    paddingBottom: 4,
    paddingHorizontal: SCREEN_MARGIN,
  },
});

export default OxyAccountDialogScreen;
