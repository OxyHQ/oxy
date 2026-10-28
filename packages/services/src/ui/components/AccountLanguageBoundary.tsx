import type { ReactNode } from 'react';
import { FALLBACK_LOCALE, getPrimaryLanguage } from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';
import { useCurrentUser } from '../hooks/queries/useAccountQueries';
import type { OxyLanguageConfig } from '../types/navigation';
import { LanguageBridge } from './LanguageBridge';

/** Owner preferences are not part of the public device/account summary. */
export function AccountLanguageBoundary({
  language,
  children,
}: {
  language?: OxyLanguageConfig;
  children: ReactNode;
}) {
  const { canUsePrivateApi, user, currentLanguage } = useOxy();
  const profile = useCurrentUser({ enabled: canUsePrivateApi });
  // The query mirrors its result into the account runtime in an effect. Wait for
  // that projection as well as the request, so the bridge never publishes the
  // compact session's fallback locale in the frame before its real preference.
  const accountReady =
    !user ||
    !canUsePrivateApi ||
    profile.fetchStatus === 'paused' ||
    user.languages !== undefined ||
    profile.isError ||
    (profile.dataUpdatedAt > 0 &&
      profile.data?.id === user.id &&
      currentLanguage === (getPrimaryLanguage(profile.data) ?? FALLBACK_LOCALE));
  return (
    <LanguageBridge config={language} accountReady={accountReady}>
      {children}
    </LanguageBridge>
  );
}
