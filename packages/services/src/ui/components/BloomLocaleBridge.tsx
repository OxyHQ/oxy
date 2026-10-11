import type { FC, ReactNode } from 'react';
import { LocaleProvider, useBloomLocale } from '@oxy.so/bloom/locale';
import { useOxy } from '../context/OxyContext';

/**
 * Bloom's own words — a field's "Show password", a dialog's "Close", "Step 2
 * of 3" — in the language Oxy resolved for this person (`currentLanguage`: the
 * account's, or signed out, the device's). Mounted by `OxyProvider` around
 * everything it renders, the app included, so the SDK's screens and the app's
 * Bloom components speak one language without the app doing anything.
 *
 * An app that sets Bloom's locale itself keeps it; the nearest provider wins:
 *   - a `LocaleProvider` (or `BloomProvider locale`) INSIDE `OxyProvider` is
 *     nearer than this one, and wins for its subtree as usual;
 *   - one OUTSIDE `OxyProvider` is the app's explicit choice, so this bridge
 *     passes it through instead of overriding it from within.
 * Only where nothing above sets a locale does Oxy's language apply.
 */
export const BloomLocaleBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { currentLanguage } = useOxy();
  const inherited = useBloomLocale();
  return <LocaleProvider locale={inherited ?? currentLanguage}>{children}</LocaleProvider>;
};
