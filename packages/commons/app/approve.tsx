import React, { useCallback, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Linking, Platform, BackHandler } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { Dialog, useDialogControl, type DialogAction } from '@oxyhq/bloom/dialog';
import { useColors } from '@/hooks/useColors';
import { CenteredState } from '@/components/ui/centered-state';
import { useTranslation } from '@/lib/i18n';
import { useCommonsApproval } from '@/hooks/commons-signin/useCommonsApproval';
import { ApprovalRequest } from '@/components/commons-signin/approval-request';
import { resolveApprovedAction } from '@/lib/commons-signin/approval-return';
import { ErrorFallback } from '@/components/error-fallback';
import { getDisplayNameOrNull } from '@/utils/date-utils';

/** How long the success confirmation lingers before we return / close. */
const APPROVED_RETURN_DELAY_MS = 1000;

/**
 * "Sign in with Oxy" approval surface (Commons / approver side).
 *
 * This is a ROOT-level route (`app/approve.tsx`, URL `/approve`), NOT part of the
 * `(scan)` group. It is deliberately outside `(scan)` because that group is a
 * `fullScreenModal` — an opaque card would sit behind the sheet, making it look
 * like a dedicated screen. As a root `transparentModal` (registered in
 * `app/_layout.tsx`) the sheet instead rises over the real underlying context
 * (the `(tabs)` anchor from `unstable_settings`), which is what the user sees.
 *
 * Reachable two ways, both carrying the public `code`:
 *   - the in-app QR scanner (`/(scan)`) replaces into `/approve` (threads `source=scanner`)
 *   - a same-device deep link `oxycommons://approve?...` / `commons://approve?...`
 *
 * Rendered as a Bloom bottom sheet (`<Dialog placement="bottom">`) — the same
 * Bloom surface `@oxyhq/services`' `OxyAccountDialog` uses. The screen owns only
 * the sheet, the request lifecycle, and the terminal states; the request itself
 * is rendered by `ApprovalRequest`, which is the concise one-primary-action
 * surface issue #691 Phase 5 asks for: `Confirm identity` opens the device
 * biometric/passcode prompt DIRECTLY (no intermediate continue step), and
 * `This wasn't me` denies.
 *
 * Driven imperatively (`useDialogControl`) so a backdrop tap, a drag-down, or an
 * explicit close all fire `onClose` — Bloom's CONTROLLED bottom placement
 * swallows those gestures. Any dismissal is a CANCEL: it never calls deny (parity
 * with the previous screen's back behavior). Only the explicit "This wasn't me"
 * action calls `deny()`, and it carries the `'not_me'` reason — the one value
 * that records the denial as suspicious rather than as an ordinary cancel.
 *
 * On a SUCCESSFUL approve the success state lingers ~1s, then Commons either
 * returns the user to the caller (same-device deep-link handoff on Android, via
 * backgrounding) or simply closes the sheet (scanner path, and iOS — no
 * programmatic backgrounding exists). See `resolveApprovedAction`.
 *
 * SECURITY: only the server-resolved `info` identity is rendered (anti-phishing
 * — never the QR's self-asserted strings); approval stays gated behind the
 * device biometric/passcode.
 */
export default function ApproveSignInScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const { code, source } = useLocalSearchParams<{ code?: string; source?: string }>();
  const control = useDialogControl();

  const { state, info, confirmationIssue, errorMessage, denialReason, approve, deny, reload } =
    useCommonsApproval(code, t('signInApproval.approve.biometricReason'));

  // Present the sheet on mount. Imperative dialog refs bind during the commit's
  // layout phase, so opening from a mount effect is the sanctioned pattern
  // (mirrors Bloom's own `AutoMountedDialog`).
  useEffect(() => {
    control.open();
  }, [control]);

  // The SINGLE navigation exit, fired by `onClose` once the sheet has finished
  // closing. A dismissal is a CANCEL and never calls deny.
  const navigateAway = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      // Cold deep link with no history — land on the ID home, not the scanner.
      router.replace('/(tabs)/(id)');
    }
  }, [router]);

  // Run the sheet's close animation, then `navigateAway` via `onClose`.
  const dismiss = useCallback(() => control.close(), [control]);

  const openLink = useCallback((url: string) => {
    Linking.openURL(url).catch((error: unknown) => {
      console.warn('[approve] failed to open external link', error);
    });
  }, []);

  const confirm = useCallback(() => {
    void approve();
  }, [approve]);

  // The sheet reports WHICH answer was given; this only forwards it. A
  // dismissal never reaches here — it is a cancel, and denies nothing.
  const reject = useCallback(() => {
    void deny('not_me');
  }, [deny]);

  // After a successful approve: briefly show the confirmation, then return to
  // the caller (deep-link handoff on Android) or close the sheet (scanner / iOS).
  useEffect(() => {
    if (state !== 'approved') return;
    const timer = setTimeout(() => {
      if (resolveApprovedAction(source, Platform.OS) === 'return-to-caller') {
        // Reset the underlying route first so a later re-open lands on the ID
        // home, then background Commons so the OS returns to the caller.
        navigateAway();
        BackHandler.exitApp();
      } else {
        dismiss();
      }
    }, APPROVED_RETURN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, source, navigateAway, dismiss]);

  // The LOCAL vault identity that would approve. Read from this device's own
  // session — never from the request — because Commons stays the identity no
  // matter which account the requesting app ends up acting as.
  const identityName = user ? getDisplayNameOrNull(user) : null;
  const confirming = state === 'confirming' || state === 'approving';
  const rejecting = state === 'denying';
  const busy = confirming || rejecting;

  let content: React.ReactNode;
  let actions: DialogAction[] | undefined;
  if (state === 'approved' || state === 'denied') {
    // --- Terminal states. Approved auto-advances (return/close); denied waits. ---
    const approved = state === 'approved';
    content = (
      <View className="px-5 py-2">
        <CenteredState
          icon={approved ? 'check-circle-outline' : 'shield-off-outline'}
          iconColor={approved ? colors.success : colors.textSecondary}
          title={
            approved
              ? t('signInApproval.approve.approvedTitle')
              : t('signInApproval.approve.deniedTitle')
          }
          body={
            approved
              ? t('signInApproval.approve.approvedBody')
              : // Honest about what was actually recorded: a `not_me` denial is
                // stored on the request and flagged for Oxy, which is all that
                // happens — no investigation is opened, so none is promised.
                t(
                  denialReason === 'not_me'
                    ? 'signInApproval.approve.deniedNotMeBody'
                    : 'signInApproval.approve.deniedBody',
                )
          }
        />
      </View>
    );
    actions = approved ? undefined : [{ label: t('signInApproval.approve.done') }];
  } else if (state === 'error') {
    // --- Error state ---
    content = (
      <View className="px-5 py-2">
        <CenteredState
          icon="alert-circle-outline"
          iconColor={colors.error}
          title={t('signInApproval.approve.errorTitle')}
          body={
            code
              ? (errorMessage ?? t('signInApproval.approve.errorBody'))
              : t('signInApproval.approve.noCode')
          }
        />
      </View>
    );
    actions = [
      ...(code
        ? [
            {
              label: t('signInApproval.approve.tryAgain'),
              onPress: reload,
              shouldCloseOnPress: false,
            } satisfies DialogAction,
          ]
        : []),
      { label: t('signInApproval.approve.done'), color: 'cancel' },
    ];
  } else if (state === 'loading' || !info?.application) {
    // --- Loading ---
    content = (
      <View className="px-5 py-2">
        <CenteredState loading body={t('signInApproval.approve.loading')} />
      </View>
    );
  } else {
    // --- Ready: the server-resolved request + the single primary action ---
    content = (
      <ApprovalRequest
        info={info}
        application={info.application}
        identityName={identityName}
        confirmationIssue={confirmationIssue}
        onClose={dismiss}
        onOpenLink={openLink}
      />
    );
    actions = [
      {
        label: t(
          confirming
            ? 'signInApproval.approve.confirming'
            : 'signInApproval.approve.confirm',
        ),
        onPress: confirm,
        shouldCloseOnPress: false,
        disabled: busy,
      },
      {
        label: t(
          rejecting
            ? 'signInApproval.approve.rejecting'
            : 'signInApproval.approve.reject',
        ),
        onPress: reject,
        shouldCloseOnPress: false,
        color: 'destructive',
        disabled: busy,
      },
      {
        label: t('common.cancel'),
        color: 'cancel',
        disabled: busy,
      },
    ];
  }

  return (
    <Dialog
      control={control}
      onClose={navigateAway}
      placement="bottom"
      label={t('signInApproval.approve.heading')}
      actions={actions}
    >
      <ScrollView
        className="w-full"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
  },
});

/**
 * Route-level error boundary — preserves the branded retry UX this surface had
 * while it lived under `(scan)/_layout.tsx`, now that it is a root route.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}
