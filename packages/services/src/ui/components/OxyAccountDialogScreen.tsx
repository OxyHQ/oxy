/**
 * OxyAccountDialogScreen — the ONE unified account dialog BODY for `@oxy.so/services`.
 *
 * The header (title/subtitle per view + back button) around the headless chooser
 * logic, which lives in `OxyAuthChooser` — the account switcher, sign-in,
 * sign-up, and QR views are ALL there, extracted so the same chooser can be
 * mounted bare by a future host with no Dialog chrome (e.g. an auth.oxy.so hub
 * page driving the cross-origin passkey popup, b2). This file owns ONLY the
 * header + the scroll body.
 *
 * It is presented as the `AccountDialog` route on the shared Bloom SURFACE STACK
 * (`@oxy.so/bloom/surfaces`) — `OxyContext.openAccountDialog` calls
 * `presentDetached('AccountDialog', …, { placement: { base: 'bottom', md:
 * 'center' }, dismissOnBackdrop: false, maxWidth: 420 })`, so the STACK owns the
 * responsive `<Dialog>` chrome and this component renders only its content. That
 * replaces the previous standalone controlled `<Dialog open={isAccountDialogOpen}>`
 * mount: dismissal now flows through the stack (backdrop/swipe disabled), and the
 * header close button (and `OxyAuthChooser`'s `onComplete`) drive
 * `useOxy().closeAccountDialog`, which dismisses the surface and runs its exit
 * animation. The view-enum (`accounts|signin|qr|add|signup`) stays internal here,
 * driven by the shared `AccountDialogController` in `@oxy.so/core`.
 */

import type React from 'react';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import type { BaseScreenProps } from '../types/navigation';
import LogoText from './logo/LogoText';
import OxyAuthChooser from './OxyAuthChooser';
import { useAccountDialogSnapshot } from '../hooks/accountDialogSnapshot';

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
 * `@oxy.so/core`. Closing routes through `useOxy().closeAccountDialog`, which
 * dismisses the surface and runs its exit animation.
 */
const OxyAccountDialogScreen: React.FC<BaseScreenProps> = ({ canGoBack }) => {
  const { accountDialogController: controller, closeAccountDialog } = useOxy();
  const { t } = useI18n();

  const snapshot = useAccountDialogSnapshot(controller);

  const { view } = snapshot;
  // Where back leads is the CONTROLLER's answer (`snapshot.backView`), never a
  // table here: a host-side "back = accounts" assumed a signed-in origin and
  // opened the account menu for nobody on a signed-out Back from sign-up.
  const showBack = snapshot.backView !== null;
  const goBack = useCallback(() => {
    // Withdraws an active request itself before leaving it.
    controller?.back();
  }, [controller]);
  // An ENTRY view (accounts / signin — no in-dialog back of its own) that is
  // MORPHED into a host surface (ManageAccount → switcher) has a frame beneath it,
  // so its back CLOSES the dialog and reshapes back to the host — routed through
  // `closeAccountDialog` so the pop + state teardown stay in one place. Opened
  // cold (detached) it is the root frame → `canGoBack` is false → no back.
  const backsToHost = !showBack && (canGoBack?.() ?? false);
  // The sign-in and sign-up screens carry their own header — the Oxy mark and
  // the large title auth.oxy.so shows — so the bar holds only the way back.
  // The account MENU is branded with the wordmark (the hero under it names the
  // account); the active request is titled, route-agnostically, because Oxy
  // picks how it travels (issue #691).

  useSurfaceHeader({
    titleContent: view === 'accounts' ? NAV_LOGO : undefined,
    title: view === 'qr' ? t('accountSwitcher.signInWithOxy') : undefined,
    onBack: showBack ? goBack : backsToHost ? closeAccountDialog : undefined,
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
    paddingBottom: 20,
    paddingHorizontal: SCREEN_MARGIN,
  },
});

export default OxyAccountDialogScreen;
