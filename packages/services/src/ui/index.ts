/**
 * @oxyhq/services/ui — public subpath
 *
 * Tree-shakeable static re-exports of the most common UI surface. Backend
 * environments (SSR) should import `@oxyhq/services/ui/server` instead;
 * client-only callers can use `@oxyhq/services/ui/client` for a slightly
 * narrower bundle.
 *
 * Static `export ... from` only — no runtime `require()`, no platform
 * conditionals. The previous `if (isFrontend) require(...)` pattern was
 * removed because it (a) violated the dual CJS/ESM build rule (ESM bundles
 * cannot contain `require()` per CLAUDE.md) and (b) defeated tree-shaking.
 */

/// <reference path="../types/react-native-classname.d.ts" />
/// <reference path="../types/react-native-web-style.d.ts" />

// Components
export { default as OxyProvider } from './components/OxyProvider';
export { default as OxySignInButton } from './components/OxySignInButton';
export { default as OxyAuthPrompt } from './components/OxyAuthPrompt';
export type { OxyAuthPromptProps } from './components/OxyAuthPrompt';
export { LogoIcon } from './components/logo/LogoIcon';
export { LogoText } from './components/logo/LogoText';
export { RequireOxyAuth } from './components/RequireOxyAuth';
export type { RequireOxyAuthProps, RequireOxyAuthPrompt } from './components/RequireOxyAuth';
export { default as FollowButton } from './components/FollowButton';
export { default as OxyPayButton } from './components/OxyPayButton';
export { default as ProfileButton } from './components/ProfileButton';

// Context + hooks
export { useOxy } from './context/OxyContext';
export { useAuth } from './hooks/useAuth';
export { useFollow, useSeedFollowStatuses } from './hooks/useFollow';
export { useStorage } from './hooks/useStorage';
export type { UseStorageOptions, UseStorageResult } from './hooks/useStorage';

// Screens
export { default as ProfileScreen } from './screens/ProfileScreen';
export { default as ManageAccountScreen } from './screens/ManageAccountScreen';
export { default as CreateAccountScreen } from './screens/CreateAccountScreen';
export { default as AccountMembersScreen } from './screens/AccountMembersScreen';
export { default as AccountSettingsScreen } from './screens/AccountSettingsScreen';

// Stores
export { useAuthStore } from './stores/authStore';
export { useAccountStore } from './stores/accountStore';

// Error handlers (pure functions)
export {
    handleAuthError,
    isInvalidSessionError,
    isTimeoutOrNetworkError,
    extractErrorMessage,
} from './utils/errorHandlers';
export type { HandleAuthErrorOptions } from './utils/errorHandlers';
