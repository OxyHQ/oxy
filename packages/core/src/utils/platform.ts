/**
 * Platform Detection Utility
 *
 * Provides platform detection WITHOUT importing from 'react-native'.
 * This allows core modules to be used in web/Node.js environments
 * without bundlers failing on react-native imports.
 */

export type PlatformOS = 'ios' | 'android' | 'web' | 'windows' | 'macos' | 'unknown';

/**
 * Shape of the RN-platform marker that the React Native entry point registers
 * on `globalThis` via {@link setPlatformOS}. Declared locally (rather than as a
 * global type augmentation) so core stays self-contained and does not leak an
 * ambient global into every consumer's type space.
 */
interface RNPlatformGlobal {
  __REACT_NATIVE_PLATFORM__?: PlatformOS;
}

/**
 * Typed view over `globalThis` for the RN-platform marker, avoiding an `any`
 * cast at each access site.
 */
function rnPlatformGlobal(): RNPlatformGlobal {
  return globalThis as unknown as RNPlatformGlobal;
}

/**
 * Detect the current platform without importing react-native
 *
 * Detection order:
 * 1. Check for React Native's Platform object on globalThis (set by RN runtime)
 * 2. Check for Node.js environment
 * 3. Check for browser environment
 * 4. Fall back to 'unknown'
 */
function detectPlatform(): PlatformOS {
  // Check if React Native Platform is available globally (set by RN runtime)
  // This avoids static imports while still detecting RN environment
  const rnPlatform = rnPlatformGlobal().__REACT_NATIVE_PLATFORM__;
  if (rnPlatform) {
    return rnPlatform;
  }

  // Check navigator.product for React Native
  if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
    // We're in React Native but Platform wasn't set globally
    // Try to get OS from userAgent or default to 'unknown'
    return 'unknown';
  }

  // Check for Node.js environment
  if (typeof process !== 'undefined' && process.versions?.node) {
    return 'web'; // Treat Node.js as 'web' for compatibility (no native features)
  }

  // Check for browser/web environment
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return 'web';
  }

  return 'unknown';
}

// Cache the platform detection result
let cachedPlatform: PlatformOS | null = null;

/**
 * Get the current platform OS
 * Safe to call from any environment (web, Node.js, React Native)
 */
export function getPlatformOS(): PlatformOS {
  if (cachedPlatform === null) {
    cachedPlatform = detectPlatform();
  }
  return cachedPlatform;
}

/**
 * Check if running on web platform (browser or Node.js)
 */
export function isWeb(): boolean {
  return getPlatformOS() === 'web';
}

/**
 * Check if running in a native app (iOS or Android)
 */
export function isNative(): boolean {
  const os = getPlatformOS();
  return os === 'ios' || os === 'android';
}

/**
 * Check if running on iOS
 */
export function isIOS(): boolean {
  return getPlatformOS() === 'ios';
}

/**
 * Check if running on Android
 */
export function isAndroid(): boolean {
  return getPlatformOS() === 'android';
}

/**
 * Set the platform OS explicitly
 * Called by React Native entry point to register the platform
 * This allows lazy detection in environments where react-native is available
 */
export function setPlatformOS(os: PlatformOS): void {
  cachedPlatform = os;
  rnPlatformGlobal().__REACT_NATIVE_PLATFORM__ = os;
}

/**
 * True only in a real web browser (a DOM is present), false on React Native
 * and Node/SSR.
 *
 * Native defines a global `window` but no `document`, so the DOM probe — not a
 * bare `window` check — is the reliable discriminator. This is the single
 * source of truth consumed by `@oxy.so/services` (which dropped
 * their local copies), so every consumer shares the exact same predicate.
 *
 * NOTE: this is a live runtime probe (not the cached `getPlatformOS()` verdict)
 * because it must reflect the actual DOM availability at call time in the
 * consumer's bundle.
 */
export function isWebBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.documentElement !== 'undefined'
  );
}

