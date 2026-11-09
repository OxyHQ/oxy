import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { coerceToSupportedLocale } from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';
import type { OxyLanguageConfig } from '../types/navigation';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Tell the app `locale`, and its fallback when that fails. Returns a promise
 * only when the app's `onChange` returned one; a synchronous `onChange` (an
 * in-memory locale store) is applied before this returns.
 */
function applyLocale(config: OxyLanguageConfig, locale: string): Promise<void> | undefined {
  const fallback = (error: unknown): Promise<void> | undefined => {
    config.onError?.(error, locale);
    if (locale === config.fallbackLocale) return undefined;
    try {
      const result = config.onChange(config.fallbackLocale);
      if (!isPromiseLike(result)) return undefined;
      return Promise.resolve(result).then(
        () => undefined,
        (fallbackError) => config.onError?.(fallbackError, config.fallbackLocale),
      );
    } catch (fallbackError) {
      config.onError?.(fallbackError, config.fallbackLocale);
      return undefined;
    }
  };
  try {
    const result = config.onChange(locale);
    if (!isPromiseLike(result)) return undefined;
    return Promise.resolve(result).then(() => undefined, fallback);
  } catch (error) {
    return fallback(error);
  }
}

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
  const { currentLanguage, isLanguageReady, isAuthResolved, isAccountLanguageKnown } = useOxy();
  // On a session host that names the language (the platform's, or the
  // account's in its snapshot), it is known before the account is published.
  const isAccountResolved = isAuthResolved || isAccountLanguageKnown;
  const resolvedLocale = config
    ? coerceToSupportedLocale(currentLanguage, config.supportedLocales, config.fallbackLocale)
    : currentLanguage;
  const configRef = useRef(config);
  configRef.current = config;
  // The change still being applied, if any: a later locale waits for it, so a
  // slow earlier catalog never lands after a later one.
  const pendingChange = useRef<Promise<void> | null>(null);
  const [prepared, setPrepared] = useState(false);

  // A layout effect: when the language is known at mount and the app applies
  // it synchronously, the app's own content is in the same commit as the
  // bridge, so its first frame is the app rather than an empty window.
  useLayoutEffect(() => {
    if (!isLanguageReady || !isAccountResolved || !accountReady) return;
    let active = true;
    const settle = (change: Promise<void>): void => {
      // A failure is the app's `onError`'s to report; the app is shown either way.
      const tracked = change
        .catch(() => undefined)
        .then(() => {
          if (active) setPrepared(true);
        });
      pendingChange.current = tracked;
      void tracked.finally(() => {
        if (pendingChange.current === tracked) pendingChange.current = null;
      });
    };
    const current = configRef.current;
    if (!current) {
      setPrepared(true);
    } else if (pendingChange.current) {
      settle(
        pendingChange.current.then(async () => {
          const latest = configRef.current;
          if (active && latest) await applyLocale(latest, resolvedLocale);
        }),
      );
    } else {
      const change = applyLocale(current, resolvedLocale);
      if (change) settle(change);
      else setPrepared(true);
    }
    // Children stay mounted after boot: changing language never destroys route state.
    return () => {
      active = false;
    };
  }, [accountReady, isAccountResolved, isLanguageReady, resolvedLocale]);

  return !config || prepared ? children : null;
}
