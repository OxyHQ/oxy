import { useOxy } from '@oxy.so/services';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from './types';

/**
 * The page's locale — the SDK's own language, so the IdP's pages and the SDK
 * screens they render (sign-in, consent) can never disagree. The SDK resolves
 * it from the device and keeps the person's choice.
 */
export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void } {
  const { currentLanguage, setLanguage } = useOxy();
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(currentLanguage)
    ? (currentLanguage as Locale)
    : DEFAULT_LOCALE;
  return { locale, setLocale: (next) => void setLanguage(next) };
}
