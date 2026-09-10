/**
 * Supported locales in the accounts app, in BCP-47 form.
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

/** Recursive JSON-shaped value for the accounts dictionary. */
export type LocaleNode = string | LocaleNode[] | { [key: string]: LocaleNode };
export type LocaleDict = Record<string, LocaleNode>;

/**
 * Translation interpolation variables. Keys are referenced as `{{key}}` in
 * translation strings.
 */
export type TranslationVars = Record<string, string | number>;

/** Signature of the translation function exposed by `useTranslation`. */
export type TranslateFn = (key: string, vars?: TranslationVars) => string;
