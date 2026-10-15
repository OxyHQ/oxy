import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useURL } from 'expo-linking';
import { AccountInvitationAcceptance } from '@oxy.so/services';

const subscribe = (onChange: () => void) => {
  if (typeof window === 'undefined' || !window.addEventListener) return () => {};
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const readToken = () =>
  typeof window === 'undefined' ? '' : (window.location?.hash.slice(1) ?? '');
const serverToken = () => '';

/** Secrets arrive in a fragment, never a request URL or persistent query cache. */
export default function InvitationPage() {
  const webToken = useSyncExternalStore(subscribe, readToken, serverToken);
  const nativeUrl = useURL();
  const token = Platform.OS === 'web' ? webToken : (nativeUrl?.split('#')[1] ?? '');
  return <AccountInvitationAcceptance token={token} />;
}
