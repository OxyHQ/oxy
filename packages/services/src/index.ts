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
export { useAccountStore } from './ui/stores/accountStore';
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
// authoritative fetch already stored.
export { upsertCachedUser, upsertCachedUsers } from './ui/hooks/queries/userCache';
export type { CacheableUser } from './ui/hooks/queries/userCache';

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
// Device notifications (the ONE `expo-notifications` adapter)
// ---------------------------------------------------------------------------
// The Expo-side half of push: permission, platform tag, and the EXPO push token
// `@oxyhq/core`'s `registerPushToken` accepts (never a raw APNs/FCM token).
// Native-only by construction — every entry point resolves its null/no-op result
// from `Platform.OS` before `expo-notifications` is ever imported, and both
// `expo-notifications` and `expo-constants` are OPTIONAL peers.
export {
    pushTokenPlatform,
    hasNotificationPermission,
    requestNotificationPermission,
    getExpoPushToken,
    takeLaunchNotificationData,
    installForegroundNotificationHandler,
    subscribeToNotificationResponses,
} from './notifications/deviceNotifications';
export type { ForegroundPresentation } from './notifications/deviceNotifications';

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
export { OxyAuthPrompt } from './ui/components/OxyAuthPrompt';
export type { OxyAuthPromptProps } from './ui/components/OxyAuthPrompt';
export { OxyOAuthCallback } from './ui/components/OxyOAuthCallback';
export type { OxyOAuthCallbackProps } from './ui/components/OxyOAuthCallback';
export { OxyConsentScreen } from './ui/components/OxyConsentScreen';
export type {
  OxyConsentScreenProps,
  OxyConsentApplication,
  OxyConsentUser,
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
export { default as OxyPayButton } from './ui/components/OxyPayButton';
export { LogoIcon } from './ui/components/logo/LogoIcon';
export { LogoText } from './ui/components/logo/LogoText';

// Sidebar account trigger. Pressing `ProfileButton` opens the unified
// `OxyAccountDialogScreen` (the single account switcher + sign-in surface) via
// `useOxy().openAccountDialog`.
export { default as ProfileButton } from './ui/components/ProfileButton';
export type { ProfileButtonProps } from './ui/components/ProfileButton';

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

// Unified switchable-accounts hook — the single source of everything the user
// can switch into: device sign-ins AND linked graph accounts (owned orgs +
// shared-with-you), deduped by account id and hydrated with real
// name/email/avatar/color. Backed by the shared `AccountDialogController` in
// `@oxyhq/core`. Every switch routes through `useOxy().switchToAccount`.
// The `SwitchableAccount` type lives in `@oxyhq/core` — import it from there.
export { useSwitchableAccounts } from './ui/hooks/useSwitchableAccounts';
export type { UseSwitchableAccountsResult } from './ui/hooks/useSwitchableAccounts';

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
