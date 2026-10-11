/**
 * Theme Utility Functions
 *
 * Consolidated theme utilities for normalizing and handling color schemes
 * across the OxyServices ecosystem.
 *
 * @module shared/utils/themeUtils
 */

/**
 * Valid theme values in the Oxy ecosystem.
 */
export type ThemeValue = 'light' | 'dark';

/**
 * Normalizes a theme value to ensure it's always 'light' or 'dark'.
 *
 * @param theme - Theme value (may be 'light' | 'dark' | string | undefined)
 * @returns Normalized 'light' | 'dark' theme (defaults to 'light')
 *
 * @example
 * ```ts
 * normalizeTheme('dark');     // 'dark'
 * normalizeTheme('light');    // 'light'
 * normalizeTheme('unknown');  // 'light'
 * normalizeTheme(undefined);  // 'light'
 * normalizeTheme(null);       // 'light'
 * ```
 */
export const normalizeTheme = (theme?: string | null): ThemeValue =>
  theme === 'light' || theme === 'dark' ? theme : 'light';

/**
 * Normalizes a color scheme value with optional fallback chain.
 *
 * Handles null/undefined cases from React Native's useColorScheme() hook
 * with a proper fallback chain.
 *
 * @param colorScheme - The color scheme from useColorScheme() hook (may be null/undefined)
 * @param theme - Optional theme prop as fallback
 * @returns Normalized 'light' | 'dark' color scheme
 *
 * @example
 * ```ts
 * // In a React Native component:
 * const systemScheme = useColorScheme(); // might be null
 * const colorScheme = normalizeColorScheme(systemScheme, props.theme);
 *
 * normalizeColorScheme('dark', 'light');      // 'dark'
 * normalizeColorScheme(null, 'dark');         // 'dark'
 * normalizeColorScheme(undefined, undefined); // 'light'
 * ```
 */
export const normalizeColorScheme = (colorScheme?: string | null, theme?: string): ThemeValue => {
  if (colorScheme === 'light' || colorScheme === 'dark') {
    return colorScheme;
  }

  if (theme === 'light' || theme === 'dark') {
    return theme;
  }

  return 'light';
};

/**
 * Gets the opposite theme value.
 *
 * @param theme - Current theme value
 * @returns The opposite theme ('light' → 'dark', 'dark' → 'light')
 *
 * @example
 * ```ts
 * getOppositeTheme('light'); // 'dark'
 * getOppositeTheme('dark');  // 'light'
 * ```
 */
export const getOppositeTheme = (theme: ThemeValue): ThemeValue =>
  theme === 'light' ? 'dark' : 'light';

/**
 * Checks if the system prefers dark mode.
 *
 * This function only works in browser environments.
 * Returns false in non-browser environments (Node.js, React Native).
 *
 * @returns true if system prefers dark mode, false otherwise
 *
 * @example
 * ```ts
 * if (systemPrefersDarkMode()) {
 *   setTheme('dark');
 * }
 * ```
 */
export const systemPrefersDarkMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/**
 * Gets the system's preferred color scheme.
 *
 * @returns 'dark' if system prefers dark mode, 'light' otherwise
 *
 * @example
 * ```ts
 * const theme = getSystemColorScheme();
 * ```
 */
export const getSystemColorScheme = (): ThemeValue => (systemPrefersDarkMode() ? 'dark' : 'light');
