import { useMemo } from 'react';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { normalizeColorScheme } from '@/utils/themeUtils';

export interface ThemeStyles {
  textColor: string;
  backgroundColor: string;
  secondaryBackgroundColor: string;
  borderColor: string;
  mutedTextColor: string;
  isDarkTheme: boolean;
  // Common semantic colors used across screens
  primaryColor: string;
  dangerColor: string;
  successColor: string;
  // Normalized color scheme and theme colors
  colorScheme: 'light' | 'dark';
  colors: typeof Colors.light;
}

/**
 * Reusable hook for theme styles
 * Adapted for test-app's simpler color structure
 */
export const useThemeStyles = (
  theme?: string,
  colorSchemeFromHook?: string | null,
): ThemeStyles => {
  const hookColorScheme = useColorScheme();
  const colorSchemeToUse = colorSchemeFromHook ?? hookColorScheme;

  return useMemo(() => {
    const colorScheme = normalizeColorScheme(colorSchemeToUse, theme);
    const isDarkTheme = colorScheme === 'dark';
    const colors = Colors[colorScheme];

    return {
      // Base colors
      textColor: colors.text,
      backgroundColor: colors.background,
      secondaryBackgroundColor: isDarkTheme ? '#222222' : '#F5F5F5',
      borderColor: isDarkTheme ? '#444444' : '#E0E0E0',
      mutedTextColor: '#8E8E93', // Same for both themes

      // Semantic colors (consistent across themes)
      primaryColor: colors.tint,
      dangerColor: '#FF3B30',
      successColor: '#34C759',

      // Theme flag
      isDarkTheme,

      // Normalized color scheme and theme colors
      colorScheme,
      colors: colors as typeof Colors.light,
    };
  }, [theme, colorSchemeToUse]);
};
