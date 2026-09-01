import { useMemo } from 'react';
import { useOptionalOxy } from '../context/OxyContext';
import { translate } from '@oxyhq/core';

/**
 * The locale `@oxyhq/core`'s translator falls back to. Mirrors its own
 * `FALLBACK`, so a surface rendered without a provider reads the same strings
 * an unrecognised locale would.
 */
const FALLBACK_LOCALE = 'en-US';

/**
 * Display copy for SDK surfaces.
 *
 * This is the ONE hook that reads the runtime optionally. The locale is display
 * metadata, not session state — ADR 0004 lists it among the things that come off
 * the central value entirely — and purely presentational surfaces
 * (`OxyConsentScreen`, `OxySignInRequestSurface`) are rendered outside a
 * provider on purpose: `packages/auth`'s production-bundle probe builds the real
 * Vite bundle and renders the surface standalone to prove every element beneath
 * it links. Throwing there would report a linkage failure that is not one.
 *
 * Anything that reads or mutates session state uses `useOxy()`, which throws.
 */
export function useI18n() {
  const oxy = useOptionalOxy();
  const currentLanguage = oxy?.currentLanguage ?? FALLBACK_LOCALE;
  const t = useMemo(() => {
    return (key: string, vars?: Record<string, string | number>) => translate(currentLanguage, key, vars);
  }, [currentLanguage]);
  return { t, locale: currentLanguage };
}
