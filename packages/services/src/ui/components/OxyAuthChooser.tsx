/**
 * OxyAuthChooser — the account switcher + sign-in/sign-up surface, WITHOUT
 * any dialog chrome.
 *
 * A thin React Native binding over the headless `AccountDialogController` in
 * `@oxy.so/core` (bound via `useSyncExternalStore`) — the same data/state
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
 *  - `add` / `signin` → `OxySignInPanel` — THE sign-in screen, the one
 *    auth.oxy.so renders too: the device's accounts, then "Continue with
 *    Oxy" (on the web, auth.oxy.so's window over the app).
 *  - `qr` → `SignInRequestView` — the ACTIVE REQUEST: the controller-bound
 *    wiring over the shared, presentational `OxySignInRequestSurface` (the same
 *    component the auth.oxy.so IdP mounts from its OAuth-bound request). It maps
 *    `snapshot.signIn` onto that surface's props; alternatives stay behind
 *    "Having trouble?" until the chosen route reports `routeFailed`.
 *  - `signup` → `OxySignUpPanel` — account creation: auth.oxy.so's window on
 *    the web, Commons on native.
 *
 * Per-account color re-theming uses Bloom's `APP_COLOR_PRESETS` + `BloomColorScope`
 * (same visual language auth.oxy.so uses). Base theming is `useTheme()` + a
 * `StyleSheet`, so this renders correctly in EVERY consumer — including apps
 * that do not use NativeWind (e.g. the accounts app).
 */

import type React from 'react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Linking, Platform } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { AUTH_WEB_ORIGIN, getNormalizedUserHandle, type OxyAuthScreen, type User } from '@oxy.so/core';
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
import SignInRequestView from './authChooser/SignInRequestView';
import { signInFailureMessage } from './authChooser/signInFailureMessage';
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
import { OxySignInPanel } from './signIn/OxySignInPanel';
import { OxySignUpPanel } from './signIn/OxySignUpPanel';

/**
 * "Accounts by Oxy" management app — the canonical home for account settings,
 * data export, and storage management. The account-menu rows deep-link into it
 * (`/data`, `/storage`, or its root) the same way `getCommonsAcquisitionUrl`
 * hands off to Commons; nothing here invents new API endpoints.
 */
const ACCOUNTS_APP_URL = 'https://accounts.oxy.so';

/**
 * The last sign-in attempt whose failure was toasted, per controller.
 *
 * Module-level, not per subscription: a failure is ONE event. Remounting the
 * chooser (or re-subscribing to the same controller) must not report it again,
 * while a NEW attempt that fails with the very same message must. The attempt
 * identity is what tells those apart; the message text cannot.
 */
const toastedFailureAttempt = new WeakMap<object, number>();

export interface OxyAuthChooserProps {
  /** Called after a completed switch, sign-in, or sign-up. */
  onComplete?: () => void;
}

/**
 * The account switcher + sign-in/sign-up chooser. Mounted by `OxyAccountDialogScreen`
 * (wrapped in Bloom's `<Dialog>`) today; mountable bare by any future host that
 * supplies its own `onComplete`.
 */
const OxyAuthChooser: React.FC<OxyAuthChooserProps> = ({ onComplete }) => {
  const {
    accountDialogController: controller,
    showBottomSheet,
    oxyServices,
    logout,
    openAvatarPicker,
    user,
    continueOnAuth,
  } = useOxy();
  const theme = useTheme();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // The device's people and what each may act as, resolved for rendering — the
  // SAME hook (and the same one builder) the auth.oxy.so chooser renders from,
  // so the two switchers cannot drift.
  const { principals } = useDeviceSwitcher();

  // On the web every sign-in and sign-up runs in auth.oxy.so's window over the
  // app (`continueOnAuth`): the passkey belongs to that origin, and the
  // browser's session lives there, shared by every Oxy app. Native has no
  // passkey path: Commons owns identity there ('none').
  const passkeyMode = useMemo<PasskeyMode>(() => (isWebBrowser() ? 'hub' : 'none'), []);

  /** auth.oxy.so's window; this surface closes once it signs the app in. */
  const openOnOxy = useCallback(
    (screen: OxyAuthScreen) => {
      void continueOnAuth(screen).then((result) => {
        if (result.status === 'signed-in') onComplete?.();
        else if (result.status === 'failed') toast.error(t('signin.errors.failed'));
      });
    },
    [continueOnAuth, onComplete, t],
  );

  // Bind the headless controller. `getSnapshot` returns a stable reference
  // between changes, so it is `useSyncExternalStore`-safe. Guard the no-provider
  // loading state (`controller` is `null`) with an inert store.
  //
  // The subscribe callback ALSO toasts sign-in device-flow failures (poll /
  // socket / popup-cancel land on `signIn` asynchronously) at the notification
  // site — an EVENT callback, not render/effect — deduped per attempt, NEVER an
  // inline banner in the request view (owner mandate).
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!controller) return () => undefined;
      const maybeToastSignInError = () => {
        const { signIn } = controller.getSnapshot();
        // The embedded QR's failures are its own to handle (it renews itself).
        if (signIn.phase !== 'error' || signIn.inline) return;
        if (toastedFailureAttempt.get(controller) === signIn.attempt) return;
        toastedFailureAttempt.set(controller, signIn.attempt);
        const message = signInFailureMessage(signIn.failure, t);
        if (message) toast.error(message);
      };
      maybeToastSignInError();
      return controller.subscribe(() => {
        maybeToastSignInError();
        listener();
      });
    },
    [controller, t],
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
      // The controller decides what choosing a row MEANS. Signed in it is a
      // switch; signed out it is "Continue as @handle" — the same sign-in
      // "Continue with Oxy" runs. The signed-out case is why this is not a
      // host-side "already active → close": the device can list an identity
      // (Commons') as active while THIS app holds no session, and closing on it
      // left the app signed out behind a sheet that looked done (#1375 item 20).
      const outcome = await controller.chooseContext(contextId).catch(() => 'failed' as const);
      switch (outcome) {
        // Another switch or removal is already changing this device: the press
        // is dropped, not queued — and it is not a failure to report.
        case 'busy':
          return;
        // The sign-in flow owns the rest: its own view while it runs, and the
        // dialog's close (through `onSignedIn`) when it completes.
        case 'signing-in':
          return;
        // Already live: activating it again bumps nothing server-side, so treat
        // the press as "yes, this one" and close.
        case 'current':
          onComplete?.();
          return;
        // The controller's own verdict on the SWITCH — never `snapshot.error`,
        // which the directory re-read after a successful switch can also set.
        case 'failed':
          toast.error(t('accountSwitcher.toasts.activateFailed'));
          return;
        case 'switched':
          // The subject changed, so every account-scoped query is now about
          // somebody else. The runtime resets its own caches between the bearer
          // commit and the notify; this drops the Query cache the same way.
          queryClient.invalidateQueries();
          onComplete?.();
          return;
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
      if (!controller || controller.isDeviceMutationInFlight()) return;
      const group = principals.find((principal) =>
        principal.contexts.some((context) => context.contextId === contextId),
      );
      const context = group?.contexts.find((row) => row.contextId === contextId);
      if (!group || !context) return;
      const confirmed = await surfaces.confirm({
        title: t('accountSwitcher.confirms.removeContextTitle'),
        description: t('accountSwitcher.confirms.removeContext', {
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
      if (!controller || controller.isDeviceMutationInFlight()) return;
      const group = principals.find((principal) => principal.principalId === principalId);
      if (!group) return;
      const confirmed = await surfaces.confirm({
        title: t('accountSwitcher.confirms.removePrincipalTitle'),
        description: t('accountSwitcher.confirms.removePrincipal', { name: group.displayName }),
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

  /**
   * Sign out of the current account, and close only once that is TRUE.
   *
   * Runs under the controller's device-mutation gate, so it can neither race a
   * switch or removal nor be issued twice by a double press. A failed
   * revocation keeps the dialog open and says so: closing it would read as
   * "signed out" while this device still holds the session.
   */
  const handleSignOut = useCallback(async () => {
    if (!controller) return;
    const outcome = await controller.runDeviceMutation(() => logout());
    if (!outcome.ran) return;
    if (outcome.value.status === 'failed') {
      toast.error(t('common.errors.signOutFailed'));
      return;
    }
    onComplete?.();
  }, [controller, logout, onComplete, t]);

  /**
   * Hand a URL to the OS. `Linking.openURL` REJECTS when nothing can open it
   * (no browser, an unregistered scheme, a blocked navigation) — a press that
   * then does nothing at all is exactly the dead end this reports instead.
   */
  const openExternal = useCallback(
    (url: string) => {
      // Wrapped so a synchronous throw lands in the same handler as a rejection.
      Promise.resolve()
        .then(() => Linking.openURL(url))
        .catch(() => {
          toast.error(t('accountSwitcher.linkOpenFailed'));
        });
    },
    [t],
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
    // No consumer override: enter the "add account" view.
    controller?.add();
  }, [consumerHooks, controller, onComplete]);

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
   * the hero keeps its real EMAIL, which the rows below do not pretend to have.
   * The accent is not in that category — every row is drawn in its own account's
   * (issue #961), this one included, from the same field.
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
      // auth.oxy.so asserts the passkey, in its window.
      onSignInWithPasskey: () => openOnOxy('signin'),
      onShowQr: () => void controller?.showQr(),
      onGetCommons: () => openExternal(getCommonsAcquisitionUrl(Platform.OS)),
      // Web: the account is made on auth.oxy.so. Native: Commons makes it.
      onCreateAccount: () => (passkeyMode === 'hub' ? openOnOxy('signup') : controller?.startSignup()),
    }),
    [passkeyMode, controller, openExternal, openOnOxy],
  );

  // Real storage usage for the account menu's "Oxy storage" block. Disabled
  // (no fetch) until a private-API session exists, so it is inert on the
  // sign-in/request/sign-up views; when present the block shows live used/total.
  // The account MENU describes the signed-in account — its hero, its storage,
  // its sign-out. The controller already refuses `accounts` without a session;
  // this is the render-side half of the same rule, so no controller state (or
  // an older core) can ever put "Sign out" in front of someone who is not
  // signed in. Without an account the sign-in entry renders in its place.
  const showsAccountMenu = view === 'accounts' && user !== null && user !== undefined;
  const storageQuery = useAccountStorageUsage({ enabled: showsAccountMenu });
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
    const openUrl = openExternal;
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
        void handleSignOut();
      },
      onOpenIdentity: passkeyMode === 'hub' ? () => openUrl(`${AUTH_WEB_ORIGIN}/identity`) : undefined,
      customItems: (consumerHooks?.menuItems ?? []).map((item) => ({
        ...item,
        onPress: () => {
          onComplete?.();
          item.onPress();
        },
      })),
    };
  }, [consumerHooks, onComplete, showBottomSheet, handleSignOut, openExternal, passkeyMode]);

  if (!controller) {
    return null;
  }

  if (showsAccountMenu) {
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
        onRetry={() => void controller.retrySignIn()}
        alternatives={alternatives}
      />
    );
  }

  if (view === 'signup') {
    return <OxySignUpPanel onSignIn={() => controller.setView('signin')} onCreateOnWeb={() => openOnOxy('signup')} />;
  }

  return (
    <OxySignInPanel
      host="dialog"
      onSignedIn={() => onComplete?.()}
      onCreateAccount={alternatives.onCreateAccount}
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
