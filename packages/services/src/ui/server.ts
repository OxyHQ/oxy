/**
 * Server-safe UI exports (noops)
 *
 * Import from this module for SSR environments where React components
 * shouldn't be rendered on the server.
 *
 * @example
 * import { OxyProvider, useOxy } from '@oxyhq/services/ui/server';
 */

// Noop utilities
const noopComponent = () => null;
const noopHook = () => ({});
const noopStorageResult = { storage: null, isReady: false };

// Components (all render null)
export const OxyProvider = noopComponent;
export const OxySignInButton = noopComponent;
export const LogoIcon = noopComponent;
export const LogoText = noopComponent;
export const FollowButton = noopComponent;
export const OxyPayButton = noopComponent;

// Context
export const useOxy = noopHook;

// Hooks (all return empty objects)
export const useAuth = noopHook;
export const useFollow = noopHook;
export const useStorage = () => noopStorageResult;

// Screens (render null)
export const ProfileScreen = noopComponent;

// Stores (return empty objects)
export const useAuthStore = noopHook;

// Toast (noop)
export const toast = Object.assign(
    () => {},
    {
        success: () => {},
        error: () => {},
        info: () => {},
        warning: () => {},
        loading: () => {},
        dismiss: () => {},
    }
);

// Error handler utilities (pure functions work everywhere)
export {
    handleAuthError,
    isInvalidSessionError,
    isTimeoutOrNetworkError,
    extractErrorMessage,
} from './utils/errorHandlers';
export type { HandleAuthErrorOptions } from './utils/errorHandlers';
