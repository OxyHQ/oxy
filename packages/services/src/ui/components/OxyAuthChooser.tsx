/**
 * OxyAuthChooser — the account switcher + sign-in/sign-up surface, WITHOUT
 * any dialog chrome.
 *
 * A thin React Native binding over the headless `AccountDialogController` in
 * `@oxyhq/core` (bound via `useSyncExternalStore`) — the same data/state
 * machine {@link OxyAccountDialogScreen} renders, extracted so it can be mounted in
 * TWO places: wrapped in Bloom's `<Dialog>` by `OxyAccountDialogScreen` (the normal
 * in-app surface), and mounted bare by a future auth.oxy.so hub page for the
 * cross-origin passkey popup (b2) — same chooser, two hosts, two completion
 * strategies via the `onComplete` prop. Neither host duplicates view logic.
 *
 * This file owns WIRING only: the controller binding, the action handlers, and
 * which view module renders. Every view lives in `./authChooser/`, one
 * responsibility each:
 *
 *  - `accounts` → `AccountsMenuView` — the signed-in Oxy account menu.
 *  - `add` / `signin` → `SignInEntryView` — ONE primary action, "Continue with
 *    Oxy" (issue #691, Phase 5). On WEB this view is transient: the flow
 *    auto-starts the instant the view is reached, because the request surface
 *    (a QR on an unknown desktop, "Check Commons on your phone" where Oxy could
 *    deliver) IS the primary route there, never something behind a second tap.
 *  - `qr` → `SignInRequestView` — the ACTIVE REQUEST: the controller-bound
 *    wiring over the shared, presentational `OxySignInRequestSurface` (the same
 *    component the auth.oxy.so IdP mounts from its OAuth-bound request). It maps
 *    `snapshot.signIn` onto that surface's props; alternatives stay behind
 *    "Having trouble?" until the chosen route reports `routeFailed`.
 *  - `signup` → `SignUpView` — account creation, Commons-first.
 *
 * Per-account color re-theming uses Bloom's `APP_COLOR_PRESETS` + `BloomColorScope`
 * (same visual language auth.oxy.so uses). Base theming is `useTheme()` + a
 * `StyleSheet`, so this renders correctly in EVERY consumer — including apps
 * that do not use NativeWind (e.g. the accounts app).
 */

import type React from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Linking, Platform } from 'react-native';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { getNormalizedUserHandle, isOxyRpOrigin, type User } from '@oxyhq/core';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../context/OxyContext';
import { useDeviceSwitcher } from '../hooks/useDeviceSwitcher';
import { useI18n } from '../hooks/useI18n';
import {
  getAccountDialogConsumerHooks,
  subscribeToAccountDialogConsumerHooks,
} from '../navigation/accountDialogManager';
import { isWebBrowser } from '../utils/isWebBrowser';
import { getCommonsAcquisitionUrl } from '../utils/commonsStoreLinks';
import { useAccountStorageUsage } from '../hooks/queries/useServicesQueries';
import AccountsMenuView from './authChooser/AccountsMenuView';
import SignInEntryView from './authChooser/SignInEntryView';
import SignInRequestView from './authChooser/SignInRequestView';
import SignUpView from './authChooser/SignUpView';
import {
  resolveAccentHex,
  type AccountHeroModel,
  type AccountStorageModel,
  type AccountsMenuActions,
  type OxyAuthChooserHandlers,
  type PasskeyMode,
  type SignInAlternatives,
} from './authChooser/types';
import { EMPTY_ACCOUNT_DIALOG_SNAPSHOT } from '../hooks/accountDialogSnapshot';

/** Commons' own identity-creation deep link (mirrors the `approve`/`attest`/`card` intents). */
const COMMONS_CREATE_IDENTITY_URL = 'oxycommons://create-identity';
/**
 * "Accounts by Oxy" management app — the canonical home for account settings,
 * data export, and storage management. The account-menu rows deep-link into it
 * (`/data`, `/storage`, or its root) the same way `getCommonsAcquisitionUrl`
 * hands off to Commons; nothing here invents new API endpoints.
 */
const ACCOUNTS_APP_URL = 'https://accounts.oxy.so';

export interface OxyAuthChooserProps {
  /** Called after a completed switch, sign-in, or sign-up. */
  onComplete?: () => void;
  /**
   * When false, the web sign-in entry does not auto-start a device-flow
   * session on mount. Use for hosts (e.g. the cross-origin passkey hub) that
   * already have a pending `authorizeCode` and must not spawn a second one.
   * @default true
   */
  autoStartSignIn?: boolean;
}

/**
 * The account switcher + sign-in/sign-up chooser. Mounted by `OxyAccountDialogScreen`
 * (wrapped in Bloom's `<Dialog>`) today; mountable bare by any future host that
 * supplies its own `onComplete`.
 */
const OxyAuthChooser: React.FC<OxyAuthChooserProps> = ({
  onComplete,
  autoStartSignIn: autoStartSignInEnabled = true,
}) => {
  const {
    accountDialogController: controller,
    showBottomSheet,
    signInWithPasskey,
    registerWithPasskey,
    oxyServices,
    logout,
    openAvatarPicker,
    user,
  } = useOxy();
  const theme = useTheme();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // The device's people and what each may act as, resolved for rendering — the
  // SAME hook (and the same one builder) the auth.oxy.so chooser renders from,
  // so the two switchers cannot drift.
  const { principals } = useDeviceSwitcher();

  // A credential minted for `oxy.so` can only be ASSERTED there (or a loopback
  // dev host) — a hard WebAuthn RP-ID boundary the browser enforces, not
  // feature detection. On a first-party Oxy web origin the ceremony runs
  // directly ('direct'). On any OTHER web origin (b2) it can't run locally, so
  // the passkey action instead opens a popup at the auth.oxy.so passkey hub —
  // where the SAME ceremony IS first-party — and relays the resulting session
  // back via `AccountDialogController.startPasskeyHubSignIn` ('hub'). Native
  // has neither: Commons owns identity there ('none'). `isOxyRpOrigin()` reads
  // `location` once and is stable for the component's lifetime.
  const passkeyMode = useMemo<PasskeyMode>(() => {
    if (!isWebBrowser()) return 'none';
    return isOxyRpOrigin() ? 'direct' : 'hub';
  }, []);

  const [signInPasskeyPending, setSignInPasskeyPending] = useState(false);
  const handleSignInWithPasskey = useCallback(async () => {
    if (signInPasskeyPending) return;
    setSignInPasskeyPending(true);
    try {
      await signInWithPasskey();
      onComplete?.();
    } catch (error) {
      // A cancelled/failed ceremony keeps the view open so the user can retry
      // or fall back to the QR — surface the reason as a toast (owner mandate:
      // errors never render inline inside the dialog), never swallow.
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('accountSwitcher.toasts.passkeySignInFailed'),
      );
    } finally {
      setSignInPasskeyPending(false);
    }
  }, [signInPasskeyPending, signInWithPasskey, onComplete, t]);

  const [createPasskeyPending, setCreatePasskeyPending] = useState(false);
  const handleCreateWithPasskey = useCallback(
    async (username: string) => {
      if (createPasskeyPending) return;
      setCreatePasskeyPending(true);
      try {
        await registerWithPasskey({ username });
        onComplete?.();
      } catch (error) {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : t('signup.toasts.passkeyCreateFailed'),
        );
      } finally {
        setCreatePasskeyPending(false);
      }
    },
    [createPasskeyPending, registerWithPasskey, onComplete, t],
  );

  // Web: auto-start "Sign in with Oxy" when the sign-in entry becomes the shown
  // view — the request surface is the PRIMARY web route, not something behind a
  // second tap (the user's ONE action was the sign-in button that opened this).
  // `signInWithOxy()` tries the shared keychain first (silently, native-only)
  // then falls to the device flow, whose route the controller picks. Driven from
  // the EVENTS that reach that view — the initial `subscribe` pass below (an
  // open-to-sign-in) and the add / back-to-sign-in handlers — never a watcher
  // effect. Guarded so it never restarts a live flow (phase must be idle) and is
  // a no-op on native (button-driven). Reads the live snapshot at call time (an
  // event callback, not render), so it is stable across renders.
  const autoStartSignIn = useCallback(() => {
    if (!autoStartSignInEnabled || !controller || !isWebBrowser()) return;
    const { view: currentView, signIn } = controller.getSnapshot();
    if ((currentView !== 'signin' && currentView !== 'add') || signIn.phase !== 'idle') return;
    void controller.signInWithOxy();
  }, [autoStartSignInEnabled, controller]);

  // Bind the headless controller. `getSnapshot` returns a stable reference
  // between changes, so it is `useSyncExternalStore`-safe. Guard the no-provider
  // loading state (`controller` is `null`) with an inert store.
  //
  // The subscribe callback ALSO carries two owner-mandated reactions to the
  // controller. These run in the subscribe / notification callbacks — EVENT
  // callbacks, not render/effect — so neither is a React effect hook:
  //  1. Sign-in device-flow failures (poll / socket / popup-cancel land on
  //     `signIn` asynchronously) are toasted at the notification site, deduped
  //     per subscription — NEVER an inline banner in the request view (owner
  //     mandate, same contract as account-switch).
  //  2. On subscribe (mount / re-subscribe — a passive effect, the SAME timing
  //     the removed effects had) the web sign-in flow auto-starts if the opening
  //     view is the sign-in entry.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!controller) return () => undefined;
      let lastToastedSignInError: string | null = null;
      const maybeToastSignInError = () => {
        const { signIn } = controller.getSnapshot();
        if (signIn.phase === 'error' && signIn.error && signIn.error !== lastToastedSignInError) {
          lastToastedSignInError = signIn.error;
          toast.error(signIn.error);
        } else if (signIn.phase !== 'error') {
          lastToastedSignInError = null;
        }
      };
      maybeToastSignInError();
      autoStartSignIn();
      return controller.subscribe(() => {
        maybeToastSignInError();
        listener();
      });
    },
    [controller, autoStartSignIn],
  );
  const getSnapshot = useCallback(
    () => (controller ? controller.getSnapshot() : EMPTY_ACCOUNT_DIALOG_SNAPSHOT),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { view } = snapshot;
  const consumerHooks = useSyncExternalStore(
    subscribeToAccountDialogConsumerHooks,
    getAccountDialogConsumerHooks,
    () => null,
  );

  const handleActivate = useCallback(
    async (contextId: string) => {
      if (!controller) return;
      if (controller.getSnapshot().activatingContextId) return;
      // Already live: activating it again bumps nothing server-side, so treat
      // the press as "yes, this one" and close.
      if (contextId === controller.getSnapshot().activeContext?.contextId) {
        onComplete?.();
        return;
      }
      try {
        await controller.activateContext(contextId);
        // Failures are recorded on the controller snapshot rather than thrown,
        // so the same path works with the real controller and with test doubles
        // that resolve void.
        if (controller.getSnapshot().error) {
          toast.error(t('accountSwitcher.toasts.activateFailed'));
          return;
        }
        // The subject changed, so every account-scoped query is now about
        // somebody else. The runtime resets its own caches between the bearer
        // commit and the notify; this drops the Query cache the same way the
        // account switch did.
        queryClient.invalidateQueries();
        onComplete?.();
      } catch {
        toast.error(t('accountSwitcher.toasts.activateFailed'));
      }
    },
    [controller, onComplete, queryClient, t],
  );

  /**
   * Remove ONE `principal → account` pair.
   *
   * Confirmed, and the confirmation says whose route is going: on a shared
   * device the same organization is reachable through somebody else, and their
   * access is untouched. That is the fact a single "remove account" control
   * would get wrong.
   */
  const handleRemoveContext = useCallback(
    async (contextId: string) => {
      if (!controller) return;
      const group = principals.find((principal) =>
        principal.contexts.some((context) => context.contextId === contextId),
      );
      const context = group?.contexts.find((row) => row.contextId === contextId);
      if (!group || !context) return;
      const confirmed = await surfaces.confirm({
        title: t('accountSwitcher.confirms.removeContextTitle'),
        message: t('accountSwitcher.confirms.removeContext', {
          person: group.displayName,
          account: context.displayName,
        }),
        confirmLabel: t('common.remove'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      const removed = await controller.signOutContext(contextId);
      if (!removed) {
        toast.error(t('accountSwitcher.toasts.contextRemoveFailed'));
        return;
      }
      toast.success(t('accountSwitcher.toasts.contextRemoved', { account: context.displayName }));
    },
    [controller, principals, t],
  );

  /** Remove ONE PERSON and every account they reach here, and nobody else's. */
  const handleRemovePrincipal = useCallback(
    async (principalId: string) => {
      if (!controller) return;
      const group = principals.find((principal) => principal.principalId === principalId);
      if (!group) return;
      const confirmed = await surfaces.confirm({
        title: t('accountSwitcher.confirms.removePrincipalTitle'),
        message: t('accountSwitcher.confirms.removePrincipal', { name: group.displayName }),
        confirmLabel: t('common.actions.signOut'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      const removed = await controller.signOutPrincipal(principalId);
      if (!removed) {
        toast.error(t('accountSwitcher.toasts.principalRemoveFailed'));
        return;
      }
      toast.success(t('accountSwitcher.toasts.principalRemoved', { name: group.displayName }));
    },
    [controller, principals, t],
  );

  const handleManage = useCallback(() => {
    onComplete?.();
    if (consumerHooks?.onNavigateManage) {
      consumerHooks.onNavigateManage();
      return;
    }
    showBottomSheet?.('ManageAccount');
  }, [consumerHooks, onComplete, showBottomSheet]);

  const handleAdd = useCallback(() => {
    if (consumerHooks?.onAddAccount) {
      onComplete?.();
      consumerHooks.onAddAccount();
      return;
    }
    // No consumer override: enter the "add account" view and auto-start the web
    // sign-in flow, from this handler (the event that reaches the view).
    controller?.add();
    autoStartSignIn();
  }, [consumerHooks, controller, autoStartSignIn, onComplete]);

  const handlers = useMemo<OxyAuthChooserHandlers>(
    () => ({
      onActivate: (contextId) => {
        void handleActivate(contextId);
      },
      onRemoveContext: (contextId) => {
        void handleRemoveContext(contextId);
      },
      onRemovePrincipal: (principalId) => {
        void handleRemovePrincipal(principalId);
      },
      onAdd: handleAdd,
      onManage: handleManage,
      // Morphs the AccountDialog surface into `ChangeAvatar` (and back), then
      // uploads / clears the picked photo — the single shared avatar write path.
      onEditAvatar: () => openAvatarPicker(),
    }),
    [handleActivate, handleRemoveContext, handleRemovePrincipal, handleAdd, handleManage, openAvatarPicker],
  );

  /**
   * The hero block — the account this client is signed in as, from its FULL
   * profile rather than from a directory row.
   *
   * The directory carries the minimum that renders a row for every person on
   * the device; this is the one account we legitimately hold everything for, so
   * the hero keeps its real email and its own accent, and the rows below do not
   * pretend to have either.
   */
  const hero = useMemo<AccountHeroModel | null>(() => (user ? buildHero(user, theme.colors.primary, oxyServices) : null),
    [user, theme.colors.primary, oxyServices],
  );

  // Everything that is NOT the surface's one primary action. Wired once here;
  // each view picks the subset that is a genuine alternative to ITS primary
  // surface and hides them behind "Having trouble?" (issue #691).
  const alternatives = useMemo<SignInAlternatives>(
    () => ({
      passkeyAvailable: passkeyMode !== 'none',
      // The hub-popup flow reports progress through `snapshot.signIn` (already
      // rendered by the request view) — only the DIRECT ceremony uses this
      // component-local pending flag. A ceremony FAILURE is toasted by
      // `handleSignInWithPasskey`, never rendered inline.
      passkeyPending: passkeyMode === 'direct' ? signInPasskeyPending : false,
      onSignInWithPasskey: () => {
        if (passkeyMode === 'direct') {
          void handleSignInWithPasskey();
          return;
        }
        void controller?.startPasskeyHubSignIn();
      },
      onShowQr: () => void controller?.showQr(),
      onGetCommons: () => void Linking.openURL(getCommonsAcquisitionUrl(Platform.OS)),
      onCreateAccount: () => controller?.startSignup(),
    }),
    [passkeyMode, signInPasskeyPending, handleSignInWithPasskey, controller],
  );

  // Real storage usage for the account menu's "Oxy storage" block. Disabled
  // (no fetch) until a private-API session exists, so it is inert on the
  // sign-in/request/sign-up views; when present the block shows live used/total.
  const storageQuery = useAccountStorageUsage({ enabled: view === 'accounts' });
  const storage = useMemo<AccountStorageModel | null>(
    () =>
      storageQuery.data
        ? {
            usedBytes: storageQuery.data.totalUsedBytes,
            limitBytes: storageQuery.data.totalLimitBytes,
          }
        : null,
    [storageQuery.data],
  );

  // The account-menu rows below the switcher: storage + data + settings + help
  // deep-link into the "Accounts by Oxy" app or open the matching in-app sheet
  // (Help, Legal); sign-out uses the SDK's own per-account sign-out. No new
  // endpoints — the same handoff pattern `handleManage`/`getCommonsAcquisitionUrl`
  // already use.
  const accountMenu = useMemo<AccountsMenuActions>(() => {
    const openUrl = (url: string) => {
      void Linking.openURL(url);
    };
    const openSheet = (config: Parameters<NonNullable<typeof showBottomSheet>>[0]) => {
      onComplete?.();
      showBottomSheet?.(config);
    };
    return {
      onOpenSettings: () => openUrl(ACCOUNTS_APP_URL),
      onOpenData: () => openUrl(`${ACCOUNTS_APP_URL}/data`),
      onManageStorage: () => openUrl(`${ACCOUNTS_APP_URL}/storage`),
      onUpgradeStorage: () => openUrl(`${ACCOUNTS_APP_URL}/payments`),
      onHelp: () => openSheet('HelpSupport'),
      onPrivacy: () => openSheet({ screen: 'LegalDocuments', props: { initialStep: 1 } }),
      onTerms: () => openSheet({ screen: 'LegalDocuments', props: { initialStep: 2 } }),
      onSignOut: () => {
        void logout();
        onComplete?.();
      },
      customItems: (consumerHooks?.menuItems ?? []).map((item) => ({
        ...item,
        onPress: () => {
          onComplete?.();
          item.onPress();
        },
      })),
    };
  }, [consumerHooks, onComplete, showBottomSheet, logout]);

  if (!controller) {
    return null;
  }

  if (view === 'accounts') {
    return (
      <AccountsMenuView
        snapshot={snapshot}
        principals={principals}
        hero={hero}
        theme={theme}
        t={t}
        handlers={handlers}
        storage={storage}
        menu={accountMenu}
      />
    );
  }

  if (view === 'qr') {
    return (
      <SignInRequestView
        snapshot={snapshot}
        t={t}
        onRetry={() => void controller.showQr()}
        alternatives={alternatives}
      />
    );
  }

  if (view === 'signup') {
    return (
      <SignUpView
        snapshot={snapshot}
        theme={theme}
        t={t}
        oxyServices={oxyServices}
        passkeyMode={passkeyMode}
        onCreateWithPasskey={(username) => void handleCreateWithPasskey(username)}
        createPending={createPasskeyPending}
        onOpenHub={() => void controller.startPasskeyHubSignIn()}
        onCreateIdentityInCommons={() => void Linking.openURL(COMMONS_CREATE_IDENTITY_URL)}
        onGetCommons={alternatives.onGetCommons}
        onBackToSignIn={() => {
          controller.setView('signin');
          autoStartSignIn();
        }}
      />
    );
  }

  return (
    <SignInEntryView
      snapshot={snapshot}
      principals={principals}
      theme={theme}
      t={t}
      handlers={handlers}
      onContinueWithOxy={() => void controller.signInWithOxy()}
      alternatives={alternatives}
    />
  );
};

/**
 * The hero model for the signed-in account.
 *
 * The address line is the account's canonical `@oxy.so` email when it has one,
 * else its normalized `@handle`. It never synthesizes a `username@oxy.so`
 * address — the identity contract forbids it, and a non-Oxy or missing email
 * falls through to the handle.
 */
function buildHero(
  user: User,
  fallbackAccent: string,
  oxyServices: ReturnType<typeof useOxy>['oxyServices'],
): AccountHeroModel {
  const handle = getNormalizedUserHandle(user);
  const displayName = user.name?.displayName?.trim() || handle || '';
  const addressLine = user.email?.toLowerCase().endsWith('@oxy.so')
    ? user.email
    : handle
      ? `@${handle}`
      : null;
  return {
    displayName,
    addressLine,
    avatarUrl: user.avatar ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb') : undefined,
    accentHex: resolveAccentHex(user.color ?? null, fallbackAccent),
  };
}

export default OxyAuthChooser;
