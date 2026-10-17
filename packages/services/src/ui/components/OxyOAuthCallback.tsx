import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { View } from 'react-native';
import { useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { isWebBrowser } from '../utils/isWebBrowser';

export interface OxyOAuthCallbackProps {
  /** Where to navigate after OAuth exchange completes. @default '/' */
  redirectTo?: string;
}

/**
 * Optional dedicated OAuth callback route for apps using `/oauth/callback`.
 * `OxyProvider` cold boot handles `?code=` on any route; mount this on the
 * callback path for a Clerk-style loading shell while auth resolves.
 */
export function OxyOAuthCallback({ redirectTo = '/' }: OxyOAuthCallbackProps) {
  const { isAuthResolved } = useAuth();

  useEffect(() => {
    if (!isAuthResolved) return;
    if (!isWebBrowser()) return;
    const location = (globalThis as { location?: Location }).location;
    if (!location) return;
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return;

    const target = redirectTo;
    if (location.pathname + location.search !== target) {
      window.location.replace(target);
    }
  }, [isAuthResolved, redirectTo]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <SpinnerIcon />
    </View>
  );
}
