/**
 * @oxyhq/services — OxyHQ Expo/React Native SDK
 *
 * Full UI components, screens, and native features for Expo apps.
 * Depends on @oxyhq/core for foundation services. Does NOT re-export from
 * @oxyhq/core — consumers import core types/values directly from `@oxyhq/core`.
 *
 * Every export below is NOMINAL — no `export *`, no compat shims.
 *
 * @example
 * ```tsx
 * import { OxyProvider, useAuth, OxySignInButton } from '@oxyhq/services';
 *
 * function App() {
 *   return (
 *     <OxyProvider baseURL="https://api.oxy.so">
 *       <YourApp />
 *     </OxyProvider>
 *   );
 * }
 * ```
 */

/// <reference path="./types/react-native-classname.d.ts" />
/// <reference path="./types/react-native-web-style.d.ts" />

import { setPlatformOS, type PlatformOS } from '@oxyhq/core';
import { Platform } from 'react-native';
setPlatformOS(Platform.OS as PlatformOS);

// ---------------------------------------------------------------------------
// Provider + auth context
// ---------------------------------------------------------------------------
export { default as OxyProvider } from './ui/components/OxyProvider';
export { useOxy } from './ui/context/OxyContext';
// `useOxy()` THROWS when no provider is mounted. `useOptionalOxy()` returns
// `null` instead, for the rare component that renders on both sides of the
// provider boundary; there is no fabricated forever-loading runtime.
export { useOptionalOxy, OxyProviderMissingError } from './ui/context/OxyContext';

// The runtime surface (ADR 0004). These subscribe to the ONE runtime with a
// selector, so — unlike `useOxy()`, whose value is rebuilt by any of its fifty
// members moving — a locale change or a dialog opening does not re-render them.
export {
  useOxyRuntime,
  useOxySnapshot,
  useActiveAccount,
  useDeviceDirectory,
  OxyRuntimeMissingError,
} from './ui/runtime';
export type {
  ActiveAccount,
  OxyRuntime,
  OxyRuntimeError,
  OxyRuntimeSnapshot,
  OxyRuntimeStatus,
  OxyTokenStatus,
} from './ui/runtime';
export type { OxyContextState } from './ui/context/OxyContext';
export { useAuth } from './ui/hooks/useAuth';
export type { AuthState, AuthActions, UseAuthReturn } from './ui/hooks/useAuth';
// Thrown by `switchToAccount` / `switchSession` while `OxyProvider` runs with
// `sessionMode="identity"` — an identity-bound app authenticates as the owner of
// the local identity key and cannot switch accounts.
export { IdentityBoundSessionError } from './ui/session/identityBinding';

// ---------------------------------------------------------------------------
// Zustand stores
// ---------------------------------------------------------------------------
export { useAuthStore } from './ui/stores/authStore';
export {
    useAssetStore,
    useAssets as useAssetsStore,
    useAsset,
    useUploadProgress,
    useAssetLoading,
    useAssetErrors,
    useAssetsByApp,
    useAssetsByEntity,
    useAssetUsageCount,
    useIsAssetLinked,
} from './ui/stores/assetStore';

// ---------------------------------------------------------------------------
// Session / asset hooks
// ---------------------------------------------------------------------------
export { useAssets, setOxyAssetInstance } from './ui/hooks/useAssets';
export { useFileDownloadUrl } from './ui/hooks/useFileDownloadUrl';
export { useFollow, useFollowerCounts, useSeedFollowStatuses } from './ui/hooks/useFollow';
export { useStorage } from './ui/hooks/useStorage';
export type { UseStorageOptions, UseStorageResult } from './ui/hooks/useStorage';

// ---------------------------------------------------------------------------
// Query hooks (TanStack Query — fetching)
// ---------------------------------------------------------------------------
export {
    useUserProfile,
    useUserProfiles,
    useCurrentUser,
    useUserById,
    useUserByUsername,
    useUsersBySessions,
    usePrivacySettings,
    useConnectedApps,
} from './ui/hooks/queries/useAccountQueries';
export {
    useSessions,
    useSession,
    useDeviceSessions,
    useUserDevices,
    useSecurityInfo,
    useAccountStorageUsage,
} from './ui/hooks/queries/useServicesQueries';
export {
    useSecurityActivity,
    useRecentSecurityActivity,
    useInfiniteSecurityActivity,
} from './ui/hooks/queries/useSecurityQueries';
export { useAuthMethods } from './ui/hooks/queries/useAuthMethods';
export {
    useUserSubscription,
    useUserPayments,
    useUserWallet,
    useUserWalletTransactions,
} from './ui/hooks/queries/usePaymentQueries';

// Payment / wallet / subscription domain types
export type {
    Subscription,
    SubscriptionPlan,
    SubscriptionStatus,
    SubscriptionFeatures,
    Payment,
    Wallet,
    WalletTransaction,
    WalletTransactionType,
    WalletTransactionStatus,
    WalletPagination,
    WalletTransactionsResponse,
} from './ui/hooks/queries/paymentTypes';

// ---------------------------------------------------------------------------
// Mutation hooks (TanStack Query — updates)
// ---------------------------------------------------------------------------
export {
    useUpdateProfile,
    useUploadAvatar,
    useUpdateAccountSettings,
    useUpdatePrivacySettings,
    useUpdateNotificationPreferences,
    useUpdateUserPreferences,
    useRevokeConnectedApp,
    useUploadFile,
} from './ui/hooks/mutations/useAccountMutations';
export {
    useSwitchSession,
    useLogoutSession,
    useLogoutAll,
    useUpdateDeviceName,
    useRemoveDevice,
} from './ui/hooks/mutations/useServicesMutations';
export {
    createProfileMutation,
    createGenericMutation,
} from './ui/hooks/mutations/mutationFactory';
export type {
    ProfileMutationConfig,
    GenericMutationConfig,
} from './ui/hooks/mutations/mutationFactory';

// Stable mutation keys for the offline queue
export { mutationKeys } from './ui/hooks/mutations/mutationKeys';

// ---------------------------------------------------------------------------
// Query keys + cache invalidation helpers
// ---------------------------------------------------------------------------
// Consumers (Mention, Homiio, Alia, accounts) use these to invalidate cached
// data after writes that touch shared backend state. Keep nominal — no
// `export *` — and never drop a public symbol without a major version bump.
export {
    queryKeys,
    invalidateAccountQueries,
    invalidateUserQueries,
    invalidateSessionQueries,
    invalidateDeviceQueries,
    invalidatePrivacyQueries,
    invalidateSecurityQueries,
    invalidateStorageQueries,
    invalidatePaymentsQueries,
    invalidateConnectedAppsQueries,
    invalidateAuthMethodsQueries,
} from './ui/hooks/queries/queryKeys';

// Canonical user-cache upsert. MERGE-upserts a (possibly partial) user into the
// SDK's user query cache under both keys it owns (by-id + viewer-scoped
// by-username). Consumers route ALL cache seeds (feed / list / search / profile
// hydration) through this so a sparse source can never strip a field an
// authoritative fetch already stored. A write that DELIBERATELY empties a field
// ("remove my picture") says so with `{ cleared: [...] }` — the payload cannot
// express it, see the module docs.
export {
    upsertCachedUser,
    upsertCachedUsers,
    CLEARABLE_USER_FIELDS,
    clearedFieldsFromProfileUpdate,
    clearedFieldsFromAccountUpdate,
} from './ui/hooks/queries/userCache';
export type {
    CacheableUser,
    ClearableUserField,
    UpsertCachedUserOptions,
} from './ui/hooks/queries/userCache';

// Mutation status aggregator (for "Syncing..." indicators)
export { useMutationStatus } from './ui/hooks/useMutationStatus';
export type { MutationStatus } from './ui/hooks/useMutationStatus';
export { useOnlineStatus } from './ui/hooks/useOnlineStatus';
export { useOxyEvent } from './ui/hooks/useOxyEvent';

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------
export {
    handleAuthError,
    isInvalidSessionError,
    isTimeoutOrNetworkError,
    extractErrorMessage,
} from './ui/utils/errorHandlers';
export type { HandleAuthErrorOptions } from './ui/utils/errorHandlers';

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------
export { useFileFiltering } from './ui/hooks/useFileFiltering';
export type { ViewMode, SortBy, SortOrder } from './ui/hooks/useFileFiltering';

// ---------------------------------------------------------------------------
// Device notifications — DELIBERATELY NOT EXPORTED HERE
// ---------------------------------------------------------------------------
// The `expo-notifications` adapter lives behind its own entry point:
//
//     import { getExpoPushToken } from '@oxyhq/services/notifications';
//
// It is the one module in this package whose dependencies (`expo-notifications`
// and `expo-constants`) are optional peers that an app which does not use push
// genuinely never installs. Re-exporting it from THIS barrel is what made that
// optionality a lie: a barrel export puts the module in the import graph of
// every consumer, and `tsc` must resolve the specifier of an `import()` even
// when the call is lazy and wrapped in try/catch — so every consumer without
// `expo-notifications` failed with TS2307 (plus TS7006 cascades) whether or not
// it had ever heard of push. Behind a subpath the module is only ever pulled in
// by an app that asked for it, which is what "optional peer" is supposed to
// mean.
//
// Do NOT re-add these exports here. `__tests__/notifications/barrelIsolation.test.ts`
// fails if you do.

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------
export {
  OXY_OAUTH_STATE_STORAGE_KEY,
  OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY,
} from '@oxyhq/core';
export { default as OxySignInButton } from './ui/components/OxySignInButton';
export type { OxySignInButtonProps, OxyOAuthResult } from './ui/components/OxySignInButton';

// Web OAuth transport (popup / redirect). RPs that ship their own sign-in
// button call `useOxy().startWebOAuthSignIn(...)`; only the popup opener is
// exported, because it MUST run synchronously inside the press handler to keep
// the browser's user-gesture attribution.
export { openOAuthPopup } from './ui/oauth/oauthPopup';
export type { StartWebOAuthSignInOptions } from './ui/oauth/browserAuthTransport';
export type {
  WebAuthMode,
  WebOAuthSignInResult,
  WebOAuthRedirectReason,
  WebOAuthFailureReason,
  WebOAuthUnsupportedReason,
  OAuthPopupHandle,
} from './ui/oauth/types';
export type {
  OAuthConsentFailureReason,
  OAuthConsentResult,
  OAuthConsentUnsupportedReason,
  RequestOAuthConsentOptions,
} from './ui/oauth/explicitOAuthConsent';
export { OxyAuthPrompt } from './ui/components/OxyAuthPrompt';
export type { OxyAuthPromptProps } from './ui/components/OxyAuthPrompt';
export { OxyOAuthCallback } from './ui/components/OxyOAuthCallback';
export type { OxyOAuthCallbackProps } from './ui/components/OxyOAuthCallback';
export { OxyConsentScreen } from './ui/components/OxyConsentScreen';
export type {
  OxyConsentScreenProps,
  OxyConsentApplication,
  OxyConsentUser,
  OxyConsentResource,
} from './ui/components/OxyConsentScreen';

// Optional signed-out gate primitive. Wrap any subtree (or the whole app via
// `OxyProvider`'s `requireAuth` prop) to opt into a shared, readiness-safe wall.
// `prompt`: `off` (render always) | `soft` (dismissible banner) | `hard` (block).
// Gates on `useOxy().canUsePrivateApi` / `isPrivateApiPending` — never flashes the
// wall before the device-first cold boot resolves. Opens the ONE account dialog.
export { RequireOxyAuth } from './ui/components/RequireOxyAuth';
export type { RequireOxyAuthProps, RequireOxyAuthPrompt } from './ui/components/RequireOxyAuth';

export { default as FollowButton } from './ui/components/FollowButton';
export type { FollowButtonProps, SingleFollowButtonProps, MultiFollowButtonProps } from './ui/components/FollowButton';
// The follow graph (#809): follows anything registered, not just users.
export {
  FollowTargetButton,
  // The product rules the button encodes, for an application drawing its own
  // affordance instead of using it — a chip grid, a compact row control.
  // Unexported, they get duplicated, and the duplicate is where the "off here"
  // rule goes wrong: pressing a follow that is switched off here must re-enable
  // it here, not unfollow everywhere.
  buildFollowMenuItems,
  resolveFollowPrimaryAction,
  FOLLOW_ACTION_LEAVES_ACTIVE,
} from './ui/components/FollowTargetButton';
export type {
  FollowTargetButtonProps,
  FollowVerb,
  FollowLabels,
  FollowDuration,
} from './ui/components/FollowTargetButton';
export { useFollowTarget } from './ui/hooks/useFollowTarget';
export type { UseFollowTargetResult } from './ui/hooks/useFollowTarget';
export {
  useFollowTargetStore,
  UNKNOWN_FOLLOW_STATUS,
  // The answer to "does the user follow this at all". Documented in
  // docs/FOLLOWS.md and, until now, not exported — so the one line of that
  // guide most likely to be reached for did not resolve.
  isFollowedGlobally,
  withApplicationMode,
  // Whether a cached status is safe to act on without a round trip — list rows
  // often carry globalState without relationshipId.
  isCompleteFollowStatus,
  followRecordToStatus,
  followRecordsToStatusMap,
} from './ui/stores/followTargetStore';
export { default as OxyPayButton } from './ui/components/OxyPayButton';
export { LogoIcon } from './ui/components/logo/LogoIcon';
export { LogoText } from './ui/components/logo/LogoText';

// Sidebar account trigger. Pressing `ProfileButton` opens the unified
// `OxyAccountDialogScreen` (the single account switcher + sign-in surface) via
// `useOxy().openAccountDialog`.
export { default as ProfileButton } from './ui/components/ProfileButton';
export type { ProfileButtonProps } from './ui/components/ProfileButton';
export type { AccountDialogMenuItem } from './ui/navigation/accountDialogManager';

// The account switcher/sign-in/sign-up chooser WITHOUT dialog chrome — the
// surface stack presents `OxyAccountDialogScreen` (which renders this) into
// Bloom's `<Dialog>` for the normal in-app surface; exported directly so a bare
// host (e.g. a future auth.oxy.so hub page) can mount the exact same chooser
// with its own completion strategy.
export { default as OxyAuthChooser } from './ui/components/OxyAuthChooser';
export type { OxyAuthChooserProps } from './ui/components/OxyAuthChooser';

// The in-flight "Sign in with Oxy" REQUEST surface — the route's primary visual,
// the progress line, and the "Having trouble?" alternatives — as a purely
// presentational component driven by plain facts. `OxyAuthChooser` renders it
// from `AccountDialogController`'s device flow; a host with a request of its own
// (the auth.oxy.so IdP's OAuth-bound lane) renders the SAME component from its
// own facts, so there is one implementation of this surface, not two. It needs
// no controller: `route` + `progress` + `qrPayload` + the failure flags are the
// whole contract, and none of them is a secret credential.
export { OxySignInRequestSurface } from './ui/components/OxySignInRequestSurface';
export type { OxySignInRequestSurfaceProps } from './ui/components/OxySignInRequestSurface';
export type { OxySignInSurfaceAction } from './ui/components/authChooser/types';

// The device switcher — the server's own directory (ADR 0002) of who is signed
// in here and what each of them may act as, grouped by PERSON, with the two
// removals an account id cannot name. Backed by the shared
// `AccountDialogController` in `@oxyhq/core`; selecting a row activates a
// `contextId`. `DevicePrincipalGroup` and `DeviceContext` live in `@oxyhq/core`
// — import them from there.
export { useDeviceSwitcher } from './ui/hooks/useDeviceSwitcher';
export type { UseDeviceSwitcherResult } from './ui/hooks/useDeviceSwitcher';

// Unified "Manage your Oxy Account" screen (the caller's own personal account)
export { default as ProfileScreen } from './ui/screens/ProfileScreen';
export { default as ManageAccountScreen } from './ui/screens/ManageAccountScreen';
export { default as NotificationsScreen } from './ui/screens/NotificationsScreen';
export { default as PreferencesScreen } from './ui/screens/PreferencesScreen';
export { default as ConnectedAppsScreen } from './ui/screens/ConnectedAppsScreen';

// Account-graph screens (organization / project / bot accounts)
export { default as CreateAccountScreen } from './ui/screens/CreateAccountScreen';
export { default as AccountMembersScreen } from './ui/screens/AccountMembersScreen';
export { default as AccountSettingsScreen } from './ui/screens/AccountSettingsScreen';

// ---------------------------------------------------------------------------
// Bottom-sheet navigation
// ---------------------------------------------------------------------------
export { showBottomSheet, closeBottomSheet } from './ui/navigation/bottomSheetManager';
export type { RouteName } from './ui/navigation/routes';

// Surface nav header — a surface screen declares its title/subtitle (+ any
// action slot) into the Dialog's OWN navigation header. Screens render no header
// of their own.
export { useSurfaceHeader, type SurfaceHeaderContent } from './ui/hooks/useSurfaceHeader';
export { SurfaceHeaderAction, type SurfaceHeaderActionProps } from './ui/components/SurfaceHeaderAction';

// ---------------------------------------------------------------------------
// Unified account dialog — imperative entry points
// ---------------------------------------------------------------------------
// Imperative account dialog entry points (outside React).
export {
  openAccountDialog,
  closeAccountDialog,
  subscribeToAccountDialog,
} from './ui/navigation/accountDialogManager';
