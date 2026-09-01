/**
 * Client-only UI exports (tree-shakeable)
 *
 * Import from this module for client-side bundles where tree-shaking is important.
 * These are direct exports without runtime detection overhead.
 *
 * @example
 * import { OxyProvider, useOxy, LogoIcon } from '@oxyhq/services/ui/client';
 */

// Components
export { default as OxyProvider } from './components/OxyProvider';
export { default as OxySignInButton } from './components/OxySignInButton';
export { default as OxyAuthPrompt } from './components/OxyAuthPrompt';
export type { OxyAuthPromptProps } from './components/OxyAuthPrompt';
export { LogoIcon } from './components/logo/LogoIcon';
export { LogoText } from './components/logo/LogoText';
export { default as FollowButton } from './components/FollowButton';
export { default as OxyPayButton } from './components/OxyPayButton';

// Context
export { useOxy, useOptionalOxy, OxyProviderMissingError } from './context/OxyContext';

// Hooks
export { useAuth } from './hooks/useAuth';
export type { AuthState, AuthActions, UseAuthReturn } from './hooks/useAuth';
export { useFollow } from './hooks/useFollow';
export { useStorage } from './hooks/useStorage';
export type { UseStorageOptions, UseStorageResult } from './hooks/useStorage';

// Screens
export { default as ProfileScreen } from './screens/ProfileScreen';
export { default as ManageAccountScreen } from './screens/ManageAccountScreen';

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
