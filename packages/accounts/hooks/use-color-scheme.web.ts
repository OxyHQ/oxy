/**
 * Web-specific colour-scheme hook.
 * Bloom's BloomThemeProvider already handles SSR / static rendering
 * and prevents the flash-of-wrong-theme, so this simply delegates.
 */
import { useTheme } from '@oxy.so/bloom/theme';

export function useColorScheme(): 'light' | 'dark' {
  const { mode } = useTheme();
  return mode;
}
