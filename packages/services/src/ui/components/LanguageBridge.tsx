import { useEffect, useRef, useState, type ReactNode } from 'react';
import { coerceToSupportedLocale } from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';
import type { OxyLanguageConfig } from '../types/navigation';

/** The SDK resolves the entry/account locale before exposing translated app content. */
export function LanguageBridge({
  config,
  accountReady = true,
  children,
}: {
  config?: OxyLanguageConfig;
  accountReady?: boolean;
  children: ReactNode;
}) {
  const { currentLanguage, isLanguageReady, isAuthResolved } = useOxy();
  const resolvedLocale = config
    ? coerceToSupportedLocale(currentLanguage, config.supportedLocales, config.fallbackLocale)
    : currentLanguage;
  const configRef = useRef(config);
  configRef.current = config;
  const pendingChange = useRef(Promise.resolve());
  const [prepared, setPrepared] = useState(false);

  useEffect(() => {
    if (!isLanguageReady || !isAuthResolved || !accountReady) return;
    let active = true;
    // A slow earlier catalog must finish before a later locale is committed.
    // Children stay mounted after boot: changing language never destroys route state.
    pendingChange.current = pendingChange.current.then(async () => {
      if (!active) return;
      const current = configRef.current;
      try {
        await current?.onChange(resolvedLocale);
      } catch (error) {
        current?.onError?.(error, resolvedLocale);
        if (current && resolvedLocale !== current.fallbackLocale) {
          try {
            await current.onChange(current.fallbackLocale);
          } catch (fallbackError) {
            current.onError?.(fallbackError, current.fallbackLocale);
          }
        }
      }
      if (active) setPrepared(true);
    });
    return () => {
      active = false;
    };
  }, [accountReady, isAuthResolved, isLanguageReady, resolvedLocale]);

  return !config || prepared ? children : null;
}
