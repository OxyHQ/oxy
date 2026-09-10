/**
 * Returns the resolved colour scheme ('light' | 'dark') from Bloom.
 * Replaces the old ThemeContext-based hook.
 */
import { useTheme } from '@oxy.so/bloom/theme';

export function useColorScheme(): 'light' | 'dark' {
  const { mode } = useTheme();
  return mode;
}
