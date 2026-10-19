/**
 * Client-only UI exports — the lean entry.
 *
 * Import from this module in an app's startup path. The root barrel also
 * re-exports the sign-in panels (`OxySignInPanel`, `OxyLinkCommonsPanel` and
 * its QR code, `OxyConsentScreen`, …) for apps that embed them, and Metro does
 * not tree-shake, so importing ANY symbol from `@oxy.so/services` ships all of
 * them — even though the account dialog that normally shows them is warmed at provider startup. Nothing exported here reaches those panels; the packaging test
 * `clientEntryIsolation` pins it.
 *
 * @example
 * import { OxyProvider, useOxy, LogoIcon } from '@oxy.so/services/ui/client';
 */

// Must stay the first runtime import: core reads the platform from it.
import '../registerPlatform';

// Components
export { default as OxyProvider } from './components/OxyProvider';
export { default as OxySignInButton } from './components/OxySignInButton';
export { default as OxyAuthPrompt } from './components/OxyAuthPrompt';
export type { OxyAuthPromptProps } from './components/OxyAuthPrompt';
export { LogoIcon } from './components/logo/LogoIcon';
export { LogoText } from './components/logo/LogoText';
export { default as FollowButton } from './components/FollowButton';
export { FollowTargetButton } from './components/FollowTargetButton';
export type {
  FollowTargetButtonProps,
  FollowVerb,
  FollowLabels,
} from './components/FollowTargetButton';
export { default as ProfileButton } from './components/ProfileButton';
export type { ProfileButtonProps } from './components/ProfileButton';
export { default as PeableButton } from './components/PeableButton';
export type { PeableButtonProps } from './components/PeableButton';
/** @deprecated Use `PeableButton` instead. */
export { default as OxyPayButton } from './components/OxyPayButton';
/** @deprecated Use `PeableButtonProps` instead. */
export type { OxyPayButtonProps } from './components/OxyPayButton';

// Context
export { useOxy, useOptionalOxy, OxyProviderMissingError } from './context/OxyContext';

// Hooks
export { useAuth } from './hooks/useAuth';
// This app's Oxy-signed assertion of which app it is (ADR 0045), for an SDK
// that attaches it to its own requests without pulling in the account screens.
export {
  useAppAssertion,
  AppAssertionProviderMissingError,
} from './appAssertion/AppAssertionContext';
export type { UseAppAssertionResult } from './appAssertion/AppAssertionContext';
export type { AppAssertionSnapshot, AppAssertionStatus } from './appAssertion/appAssertionManager';
export type { AuthState, AuthActions, SignInOutcome, UseAuthReturn } from './hooks/useAuth';
export { createDeferredProductAnalytics } from './analytics/productAnalytics';
export type { OxyProductEvent, ProductAnalytics } from './analytics/productAnalytics';
export { useFollow, useFollowerCounts, useSeedFollowStatuses } from './hooks/useFollow';
export { useFollowTarget } from './hooks/useFollowTarget';
export { useSupervision, supervisionQueryKeys } from './hooks/queries/useSupervision';
export type { UseFollowTargetResult } from './hooks/useFollowTarget';
export {
  useUserProfile,
  useUserProfiles,
  useCurrentUser,
  useUserById,
  useUserByUsername,
} from './hooks/queries/useAccountQueries';
export { useStorage } from './hooks/useStorage';
// Realtime events and the profile mutation, which startup code (a socket hook,
// a locale provider) needs without the root barrel's account screens.
export { useOxyEvent } from './hooks/useOxyEvent';
// Data hooks a product screen needs (a review's photo upload, a price in the
// viewer's currency, a "Syncing..." badge) without the root barrel's screens:
// mercaria.co shipped ~225 KB gzip of account screens on first paint because
// its review upload could only get `useUploadFile` from the root.
export {
  useUpdateProfile,
  useUploadAvatar,
  useUploadFile,
} from './hooks/mutations/useAccountMutations';
export { useFileDownloadUrl } from './hooks/useFileDownloadUrl';
export { useMutationStatus } from './hooks/useMutationStatus';
export type { MutationStatus } from './hooks/useMutationStatus';
export { useOnlineStatus } from './hooks/useOnlineStatus';
export { useDisplayCurrency } from './hooks/useDisplayCurrency';
export { useDisplayPrice } from './hooks/useDisplayPrice';
export { DisplayCurrencySelector } from './components/DisplayCurrencySelector';
export type { UseStorageOptions, UseStorageResult } from './hooks/useStorage';

// Route screens live at `@oxy.so/services/screens` so client imports preserve
// the lean startup bundle; the provider warms their shared chunk before navigation.

// Follow rules, for an app drawing its own follow affordance
export {
  buildFollowMenuItems,
  resolveFollowPrimaryAction,
  FOLLOW_ACTION_LEAVES_ACTIVE,
} from './components/followRules';
export type { FollowDuration, FollowMenuItem } from './components/followRules';

// Query keys, cache invalidation and the canonical user-cache upsert
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
} from './hooks/queries/queryKeys';
export {
  upsertCachedUser,
  upsertCachedUsers,
  CLEARABLE_USER_FIELDS,
  clearedFieldsFromProfileUpdate,
  clearedFieldsFromAccountUpdate,
} from './hooks/queries/userCache';
export type {
  CacheableUser,
  ClearableUserField,
  UpsertCachedUserOptions,
} from './hooks/queries/userCache';

// Stores
export { useAuthStore } from './stores/authStore';

// Error handler utilities
export {
  handleAuthError,
  isInvalidSessionError,
  isTimeoutOrNetworkError,
  extractErrorMessage,
} from './utils/errorHandlers';
export type { HandleAuthErrorOptions } from './utils/errorHandlers';
