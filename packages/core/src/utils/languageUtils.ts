/**
 * Locale utilities for OxyServices.
 *
 * The Oxy platform models account languages as full BCP-47 locales
 * (`language-REGION`, e.g. `es-ES`, `es-MX`, `pt-BR`). Region is significant:
 * "Spanish (Spain)" is a different locale than "Spanish (Mexico)". A user's
 * account locales live on `User.languages` as an ordered list with the PRIMARY
 * (UI) locale first — there is no singular `language` field.
 *
 * This module is the single source of truth for the supported-locale catalog
 * and every locale operation the SDK exposes: parsing base subtags, canonical
 * normalization, validation, metadata lookup, and resolving a user's locales.
 * It is pure and side-effect free.
 */

import type { User } from '../models/interfaces';

/**
 * A supported BCP-47 locale in the Oxy catalog.
 */
export interface SupportedLanguage {
  /** Canonical BCP-47 locale tag, `language-REGION` (e.g. `'es-ES'`). */
  code: string;
  /** ISO 639-1 base language subtag, lowercased (e.g. `'es'`). */
  language: string;
  /** ISO 3166-1 alpha-2 region subtag, uppercased (e.g. `'ES'`). */
  region: string;
  /** English display name, `'Language (Region)'` (e.g. `'Spanish (Spain)'`). */
  name: string;
  /** Endonym — the name as written in the locale itself (e.g. `'Español (España)'`). */
  nativeName: string;
  /** `true` when the locale is written right-to-left. Omitted for LTR locales. */
  rtl?: boolean;
}

/**
 * The supported-locale catalog. Ordered by prominence for display; the order
 * is not otherwise significant. Every entry is a full `language-REGION` tag,
 * with the base subtag lowercased and the region uppercased.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  // English
  { code: 'en-US', language: 'en', region: 'US', name: 'English (United States)', nativeName: 'English (United States)' },
  { code: 'en-GB', language: 'en', region: 'GB', name: 'English (United Kingdom)', nativeName: 'English (United Kingdom)' },
  { code: 'en-AU', language: 'en', region: 'AU', name: 'English (Australia)', nativeName: 'English (Australia)' },
  { code: 'en-CA', language: 'en', region: 'CA', name: 'English (Canada)', nativeName: 'English (Canada)' },
  { code: 'en-IN', language: 'en', region: 'IN', name: 'English (India)', nativeName: 'English (India)' },

  // Spanish
  { code: 'es-ES', language: 'es', region: 'ES', name: 'Spanish (Spain)', nativeName: 'Español (España)' },
  { code: 'es-MX', language: 'es', region: 'MX', name: 'Spanish (Mexico)', nativeName: 'Español (México)' },
  { code: 'es-US', language: 'es', region: 'US', name: 'Spanish (United States)', nativeName: 'Español (Estados Unidos)' },
  { code: 'es-AR', language: 'es', region: 'AR', name: 'Spanish (Argentina)', nativeName: 'Español (Argentina)' },
  { code: 'es-CO', language: 'es', region: 'CO', name: 'Spanish (Colombia)', nativeName: 'Español (Colombia)' },

  // Portuguese
  { code: 'pt-BR', language: 'pt', region: 'BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  { code: 'pt-PT', language: 'pt', region: 'PT', name: 'Portuguese (Portugal)', nativeName: 'Português (Portugal)' },

  // French
  { code: 'fr-FR', language: 'fr', region: 'FR', name: 'French (France)', nativeName: 'Français (France)' },
  { code: 'fr-CA', language: 'fr', region: 'CA', name: 'French (Canada)', nativeName: 'Français (Canada)' },

  // German
  { code: 'de-DE', language: 'de', region: 'DE', name: 'German (Germany)', nativeName: 'Deutsch (Deutschland)' },
  { code: 'de-AT', language: 'de', region: 'AT', name: 'German (Austria)', nativeName: 'Deutsch (Österreich)' },
  { code: 'de-CH', language: 'de', region: 'CH', name: 'German (Switzerland)', nativeName: 'Deutsch (Schweiz)' },

  // Italian
  { code: 'it-IT', language: 'it', region: 'IT', name: 'Italian (Italy)', nativeName: 'Italiano (Italia)' },

  // Dutch
  { code: 'nl-NL', language: 'nl', region: 'NL', name: 'Dutch (Netherlands)', nativeName: 'Nederlands (Nederland)' },
  { code: 'nl-BE', language: 'nl', region: 'BE', name: 'Dutch (Belgium)', nativeName: 'Nederlands (België)' },

  // Nordic
  { code: 'sv-SE', language: 'sv', region: 'SE', name: 'Swedish (Sweden)', nativeName: 'Svenska (Sverige)' },
  { code: 'nb-NO', language: 'nb', region: 'NO', name: 'Norwegian Bokmål (Norway)', nativeName: 'Norsk bokmål (Norge)' },
  { code: 'da-DK', language: 'da', region: 'DK', name: 'Danish (Denmark)', nativeName: 'Dansk (Danmark)' },
  { code: 'fi-FI', language: 'fi', region: 'FI', name: 'Finnish (Finland)', nativeName: 'Suomi (Suomi)' },

  // Central & Eastern Europe
  { code: 'pl-PL', language: 'pl', region: 'PL', name: 'Polish (Poland)', nativeName: 'Polski (Polska)' },
  { code: 'cs-CZ', language: 'cs', region: 'CZ', name: 'Czech (Czechia)', nativeName: 'Čeština (Česko)' },
  { code: 'sk-SK', language: 'sk', region: 'SK', name: 'Slovak (Slovakia)', nativeName: 'Slovenčina (Slovensko)' },
  { code: 'hu-HU', language: 'hu', region: 'HU', name: 'Hungarian (Hungary)', nativeName: 'Magyar (Magyarország)' },
  { code: 'ro-RO', language: 'ro', region: 'RO', name: 'Romanian (Romania)', nativeName: 'Română (România)' },
  { code: 'bg-BG', language: 'bg', region: 'BG', name: 'Bulgarian (Bulgaria)', nativeName: 'Български (България)' },
  { code: 'hr-HR', language: 'hr', region: 'HR', name: 'Croatian (Croatia)', nativeName: 'Hrvatski (Hrvatska)' },
  { code: 'sr-RS', language: 'sr', region: 'RS', name: 'Serbian (Serbia)', nativeName: 'Српски (Србија)' },
  { code: 'sl-SI', language: 'sl', region: 'SI', name: 'Slovenian (Slovenia)', nativeName: 'Slovenščina (Slovenija)' },
  { code: 'lt-LT', language: 'lt', region: 'LT', name: 'Lithuanian (Lithuania)', nativeName: 'Lietuvių (Lietuva)' },
  { code: 'lv-LV', language: 'lv', region: 'LV', name: 'Latvian (Latvia)', nativeName: 'Latviešu (Latvija)' },
  { code: 'et-EE', language: 'et', region: 'EE', name: 'Estonian (Estonia)', nativeName: 'Eesti (Eesti)' },
  { code: 'uk-UA', language: 'uk', region: 'UA', name: 'Ukrainian (Ukraine)', nativeName: 'Українська (Україна)' },
  { code: 'ru-RU', language: 'ru', region: 'RU', name: 'Russian (Russia)', nativeName: 'Русский (Россия)' },
  { code: 'el-GR', language: 'el', region: 'GR', name: 'Greek (Greece)', nativeName: 'Ελληνικά (Ελλάδα)' },

  // Turkish
  { code: 'tr-TR', language: 'tr', region: 'TR', name: 'Turkish (Türkiye)', nativeName: 'Türkçe (Türkiye)' },

  // Catalan
  { code: 'ca-ES', language: 'ca', region: 'ES', name: 'Catalan (Spain)', nativeName: 'Català (Espanya)' },

  // East, South & Southeast Asia
  { code: 'ja-JP', language: 'ja', region: 'JP', name: 'Japanese (Japan)', nativeName: '日本語 (日本)' },
  { code: 'ko-KR', language: 'ko', region: 'KR', name: 'Korean (South Korea)', nativeName: '한국어 (대한민국)' },
  { code: 'zh-CN', language: 'zh', region: 'CN', name: 'Chinese (Simplified, China)', nativeName: '中文 (中国)' },
  { code: 'zh-TW', language: 'zh', region: 'TW', name: 'Chinese (Traditional, Taiwan)', nativeName: '中文 (台灣)' },
  { code: 'zh-HK', language: 'zh', region: 'HK', name: 'Chinese (Traditional, Hong Kong)', nativeName: '中文 (香港)' },
  { code: 'hi-IN', language: 'hi', region: 'IN', name: 'Hindi (India)', nativeName: 'हिन्दी (भारत)' },
  { code: 'bn-BD', language: 'bn', region: 'BD', name: 'Bengali (Bangladesh)', nativeName: 'বাংলা (বাংলাদেশ)' },
  { code: 'id-ID', language: 'id', region: 'ID', name: 'Indonesian (Indonesia)', nativeName: 'Bahasa Indonesia (Indonesia)' },
  { code: 'ms-MY', language: 'ms', region: 'MY', name: 'Malay (Malaysia)', nativeName: 'Bahasa Melayu (Malaysia)' },
  { code: 'th-TH', language: 'th', region: 'TH', name: 'Thai (Thailand)', nativeName: 'ไทย (ประเทศไทย)' },
  { code: 'vi-VN', language: 'vi', region: 'VN', name: 'Vietnamese (Vietnam)', nativeName: 'Tiếng Việt (Việt Nam)' },

  // Right-to-left
  { code: 'ar-SA', language: 'ar', region: 'SA', name: 'Arabic (Saudi Arabia)', nativeName: 'العربية (السعودية)', rtl: true },
  { code: 'ar-EG', language: 'ar', region: 'EG', name: 'Arabic (Egypt)', nativeName: 'العربية (مصر)', rtl: true },
  { code: 'he-IL', language: 'he', region: 'IL', name: 'Hebrew (Israel)', nativeName: 'עברית (ישראל)', rtl: true },
  { code: 'fa-IR', language: 'fa', region: 'IR', name: 'Persian (Iran)', nativeName: 'فارسی (ایران)', rtl: true },
  { code: 'ur-PK', language: 'ur', region: 'PK', name: 'Urdu (Pakistan)', nativeName: 'اردو (پاکستان)', rtl: true },
];

/** Canonical fallback locale used when a display value cannot be resolved. */
export const FALLBACK_LOCALE = 'en-US';

/** O(1) lookup of a catalog entry by its canonical code. */
const LOCALE_BY_CODE: ReadonlyMap<string, SupportedLanguage> = new Map(
  SUPPORTED_LANGUAGES.map((entry) => [entry.code, entry]),
);

/**
 * Extract the base language subtag from a locale, lowercased.
 *
 * Tolerant of bare base subtags and of extra subtags (script/variant):
 * `'es-ES'` → `'es'`, `'es'` → `'es'`, `'zh-Hant-TW'` → `'zh'`. Returns an
 * empty string for empty input.
 */
export function getBaseLanguage(locale: string): string {
  return locale.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * Normalize a locale string to its canonical `language-REGION` form when it is
 * a supported locale, otherwise `undefined`.
 *
 * Canonicalization lowercases the base subtag and uppercases the region
 * subtag (`'es-es'` → `'es-ES'`, `'EN-us'` → `'en-US'`) and validates the
 * result against {@link SUPPORTED_LANGUAGES}. A bare base subtag (`'es'`) has
 * no region and is therefore not a locale — it returns `undefined`.
 */
export function normalizeLocale(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split('-');
  if (parts.length < 2) return undefined;

  const base = parts[0]?.toLowerCase();
  const region = parts[parts.length - 1]?.toUpperCase();
  if (!base || !region) return undefined;

  const canonical = `${base}-${region}`;
  return LOCALE_BY_CODE.has(canonical) ? canonical : undefined;
}

/**
 * Whether `input` resolves to a supported BCP-47 locale.
 */
export function isSupportedLocale(input: string): boolean {
  return normalizeLocale(input) !== undefined;
}

/**
 * Resolve catalog metadata for a locale.
 *
 * @param code - A locale tag (any case; e.g. `'es-ES'`, `'es-es'`).
 * @returns The {@link SupportedLanguage} entry, or `null` when the tag is empty
 *   or not a supported locale.
 */
export function getLanguageMetadata(code: string | null | undefined): SupportedLanguage | null {
  if (!code) return null;
  const canonical = normalizeLocale(code);
  if (!canonical) return null;
  return LOCALE_BY_CODE.get(canonical) ?? null;
}

/**
 * English display name for a locale (e.g. `'Spanish (Spain)'`).
 * Falls back to the input tag, then {@link FALLBACK_LOCALE}.
 */
export function getLanguageName(code: string | null | undefined): string {
  return getLanguageMetadata(code)?.name || code || FALLBACK_LOCALE;
}

/**
 * Native display name (endonym) for a locale (e.g. `'Español (España)'`).
 * Falls back to the input tag, then {@link FALLBACK_LOCALE}.
 */
export function getNativeLanguageName(code: string | null | undefined): string {
  return getLanguageMetadata(code)?.nativeName || code || FALLBACK_LOCALE;
}

/**
 * Base language subtags whose scripts are written right-to-left. Used to drive
 * `I18nManager.forceRTL(...)` on React Native and `<html dir="rtl">` on web.
 * Includes Arabic (`ar`), Hebrew (`he` / legacy `iw`), Persian (`fa`), and
 * Urdu (`ur`).
 */
const RTL_LANGUAGE_BASES: ReadonlySet<string> = new Set(['ar', 'he', 'iw', 'fa', 'ur']);

/**
 * Whether a locale (or bare base subtag) is written right-to-left. Unknown
 * tags are treated as left-to-right.
 */
export function isRTLLocale(locale?: string | null): boolean {
  if (!locale) return false;
  return RTL_LANGUAGE_BASES.has(getBaseLanguage(locale));
}

/**
 * Resolve the ordered list of account locales for a user, primary first.
 *
 * Reads `user.languages` (the only source — there is no singular `language`
 * field), then normalizes each entry to its canonical `language-REGION` form,
 * drops non-string and unsupported entries, and de-duplicates while preserving
 * first-seen order. Pure and side-effect free — never throws on bad input.
 */
export function getUserLanguages(user: Pick<User, 'languages'> | null | undefined): string[] {
  const source = user?.languages;
  if (!Array.isArray(source)) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of source) {
    if (typeof entry !== 'string') continue;
    const canonical = normalizeLocale(entry);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }

  return result;
}

/**
 * Resolve the single PRIMARY locale for a user (the first entry from
 * {@link getUserLanguages}), or `undefined` when the user has no supported
 * locale.
 */
export function getPrimaryLanguage(user: Pick<User, 'languages'> | null | undefined): string | undefined {
  return getUserLanguages(user)[0];
}

/**
 * Coerce a locale down to one from a CALLER-provided catalog: an exact
 * canonical match wins, else the closest entry sharing the same base
 * language (an `es-MX` account reads a host app's `es-ES` catalog), else
 * `fallback`.
 *
 * A host app's own shipped translation catalog is rarely {@link SUPPORTED_LANGUAGES}
 * itself — Oxy's account-locale catalog is broader than any one app's
 * translated strings — so this is the one place that gap is bridged. Every Oxy
 * app was independently re-deriving this exact algorithm against its own
 * catalog before it moved here.
 */
export function coerceToSupportedLocale(
  locale: string | null | undefined,
  supportedLocales: readonly string[],
  fallback: string,
): string {
  if (locale) {
    const canonical = normalizeLocale(locale);
    if (canonical && supportedLocales.includes(canonical)) {
      return canonical;
    }
    const base = getBaseLanguage(locale);
    const byBase = supportedLocales.find((entry) => getBaseLanguage(entry) === base);
    if (byBase) return byBase;
  }
  return fallback;
}
