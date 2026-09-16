import { useEffect, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';

/**
 * Web variant: static rendering has no color scheme, so the first client render
 * reports light and the real scheme applies after hydration. Narrowed to the two
 * schemes the theme defines, like the native hook.
 */
export function useColorScheme(): 'light' | 'dark' {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const colorScheme = useSystemColorScheme();
  return hasHydrated && colorScheme === 'dark' ? 'dark' : 'light';
}
