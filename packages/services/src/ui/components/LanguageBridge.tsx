import { useEffect, useMemo, useRef } from 'react';
import { coerceToSupportedLocale } from '@oxy.so/core';
import { useOxy } from '../context/OxyContext';
import type { OxyLanguageConfig } from '../types/navigation';

/**
 * `OxyProvider`'s language config prop, realized. Oxy decides which
 * language an account (or, signed out, the device/guest locale) should see;
 * this is the ONE place that decision reaches the host app's own i18n library
 * — so an app never re-derives or imperatively tracks a language of its own,
 * and never mounts anything extra to get it. It owns only its translation
 * catalogs.
 *
 * `currentLanguage` may name a locale the host app never shipped a catalog
 * for — {@link coerceToSupportedLocale} narrows it to the closest one the app
 * actually has (exact match, then same base language, then `fallbackLocale`).
 *
 * Renders nothing. Mounted by `OxyProvider` INSIDE `OxyRuntimeProvider` only
 * when this config is supplied, so an app with no i18n of its own pays
 * nothing.
 */
export function LanguageBridge({ supportedLocales, fallbackLocale, onChange, onError }: OxyLanguageConfig): null {
    const { currentLanguage } = useOxy();
    const resolvedLocale = useMemo(
        () => coerceToSupportedLocale(currentLanguage, supportedLocales, fallbackLocale),
        [currentLanguage, supportedLocales, fallbackLocale],
    );

    // Refs, not effect dependencies: an inline `onChange`/`onError` (the common
    // case) must not re-fire the effect on every render — only a genuine
    // change in the RESOLVED locale should call it again.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    useEffect(() => {
        Promise.resolve(onChangeRef.current(resolvedLocale)).catch((error: unknown) => {
            onErrorRef.current?.(error, resolvedLocale);
        });
    }, [resolvedLocale]);

    return null;
}
