/**
 * Supported locales in the auth web app, in BCP-47 form.
 * Mirrors the locales available in `@oxy.so/core` `translate()`.
 */
export type Locale =
  | 'en-US'
  | 'es-ES'
  | 'ca-ES'
  | 'fr-FR'
  | 'de-DE'
  | 'it-IT'
  | 'pt-PT'
  | 'ja-JP'
  | 'ko-KR'
  | 'zh-CN'
  | 'ar-SA';

export const SUPPORTED_LOCALES: readonly Locale[] = [
  'en-US',
  'es-ES',
  'ca-ES',
  'fr-FR',
  'de-DE',
  'it-IT',
  'pt-PT',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'ar-SA',
] as const;

export const DEFAULT_LOCALE: Locale = 'en-US';

/** Display labels for the language picker, in the native script. */
export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English',
  'es-ES': 'Español',
  'ca-ES': 'Català',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'it-IT': 'Italiano',
  'pt-PT': 'Português',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'zh-CN': '中文',
  'ar-SA': 'العربية',
};

/** Recursive JSON-shaped value for the auth dictionary. */
export type LocaleNode = string | LocaleNode[] | { [key: string]: LocaleNode };
export type LocaleDict = Record<string, LocaleNode>;

/**
 * Translation interpolation variables. Keys are referenced as `{{key}}` in
 * translation strings.
 */
export type TranslationVars = Record<string, string | number>;

/** Signature of the translation function exposed by `useTranslation`. */
export type TranslateFn = (key: string, vars?: TranslationVars) => string;
