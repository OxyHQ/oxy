import { useEffect } from 'react';
import { useLocale } from './locale';

/** Keeps `<html lang dir>` on the page's locale, for screen readers and `:dir()`. */
export function DocumentLanguage() {
  const { locale } = useLocale();
  useEffect(() => {
    const html = document.documentElement;
    html.lang = locale;
    html.dir = locale === 'ar-SA' ? 'rtl' : 'ltr';
  }, [locale]);
  return null;
}
