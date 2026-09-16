import { useColorScheme as useSystemColorScheme } from 'react-native';

/**
 * The system color scheme, narrowed to the two schemes the theme defines.
 * React Native can also report `'unspecified'` (or `null`); both read as light.
 */
export function useColorScheme(): 'light' | 'dark' {
  return useSystemColorScheme() === 'dark' ? 'dark' : 'light';
}
