import {
  SUPPORTED_LANGUAGES,
  getBaseLanguage,
  normalizeLocale,
  isSupportedLocale,
  getLanguageMetadata,
  getLanguageName,
  getNativeLanguageName,
  isRTLLocale,
  getUserLanguages,
  getPrimaryLanguage,
  coerceToSupportedLocale,
} from '../languageUtils';

describe('getBaseLanguage', () => {
  it('extracts the base subtag from a full locale, lowercased', () => {
    expect(getBaseLanguage('es-ES')).toBe('es');
    expect(getBaseLanguage('EN-us')).toBe('en');
  });

  it('is tolerant of a bare base subtag', () => {
    expect(getBaseLanguage('es')).toBe('es');
    expect(getBaseLanguage('ES')).toBe('es');
  });

  it('ignores script/variant subtags', () => {
    expect(getBaseLanguage('zh-Hant-TW')).toBe('zh');
  });

  it('trims surrounding whitespace and handles empty input', () => {
    expect(getBaseLanguage('  fr-FR ')).toBe('fr');
    expect(getBaseLanguage('')).toBe('');
  });
});

describe('normalizeLocale', () => {
  it('canonicalizes case: lowercase base, uppercase region', () => {
    expect(normalizeLocale('es-es')).toBe('es-ES');
    expect(normalizeLocale('EN-us')).toBe('en-US');
    expect(normalizeLocale('PT-br')).toBe('pt-BR');
  });

  it('returns already-canonical supported locales unchanged', () => {
    expect(normalizeLocale('es-MX')).toBe('es-MX');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLocale('  fr-CA  ')).toBe('fr-CA');
  });

  it('collapses extra subtags to language-REGION', () => {
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-TW');
  });

  it('returns undefined for a bare base subtag (no region)', () => {
    expect(normalizeLocale('es')).toBeUndefined();
    expect(normalizeLocale('en')).toBeUndefined();
  });

  it('returns undefined for unsupported locales', () => {
    expect(normalizeLocale('xx-ZZ')).toBeUndefined();
    expect(normalizeLocale('es-ZZ')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace input', () => {
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale('   ')).toBeUndefined();
  });
});

describe('isSupportedLocale', () => {
  it('is true for supported locales in any case', () => {
    expect(isSupportedLocale('es-ES')).toBe(true);
    expect(isSupportedLocale('es-es')).toBe(true);
  });

  it('is false for bare subtags and unknown locales', () => {
    expect(isSupportedLocale('es')).toBe(false);
    expect(isSupportedLocale('xx-ZZ')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
  });
});

describe('getLanguageMetadata', () => {
  it('resolves a supported locale to its catalog entry', () => {
    const entry = getLanguageMetadata('es-mx');
    expect(entry).not.toBeNull();
    expect(entry?.code).toBe('es-MX');
    expect(entry?.language).toBe('es');
    expect(entry?.region).toBe('MX');
  });

  it('returns null for bare, unknown, or empty codes', () => {
    expect(getLanguageMetadata('es')).toBeNull();
    expect(getLanguageMetadata('xx-ZZ')).toBeNull();
    expect(getLanguageMetadata('')).toBeNull();
    expect(getLanguageMetadata(null)).toBeNull();
    expect(getLanguageMetadata(undefined)).toBeNull();
  });
});

describe('getLanguageName / getNativeLanguageName', () => {
  it('returns the English and native display names for a supported locale', () => {
    expect(getLanguageName('es-ES')).toBe('Spanish (Spain)');
    expect(getNativeLanguageName('es-ES')).toBe('Español (España)');
  });

  it('falls back to the input tag for unsupported locales', () => {
    expect(getLanguageName('xx-ZZ')).toBe('xx-ZZ');
    expect(getNativeLanguageName('xx-ZZ')).toBe('xx-ZZ');
  });

  it('falls back to the fallback locale for empty input', () => {
    expect(getLanguageName('')).toBe('en-US');
    expect(getNativeLanguageName(null)).toBe('en-US');
  });
});

describe('isRTLLocale', () => {
  it('is true for right-to-left locales and their base subtags', () => {
    expect(isRTLLocale('ar-SA')).toBe(true);
    expect(isRTLLocale('he-IL')).toBe(true);
    expect(isRTLLocale('fa')).toBe(true);
    expect(isRTLLocale('ur-PK')).toBe(true);
  });

  it('is false for left-to-right locales and empty input', () => {
    expect(isRTLLocale('en-US')).toBe(false);
    expect(isRTLLocale('es-ES')).toBe(false);
    expect(isRTLLocale(null)).toBe(false);
    expect(isRTLLocale(undefined)).toBe(false);
  });
});

describe('getUserLanguages', () => {
  it('normalizes and validates the plural array, preserving order', () => {
    expect(getUserLanguages({ languages: ['es-es', 'EN-us', 'pt-BR'] })).toEqual([
      'es-ES',
      'en-US',
      'pt-BR',
    ]);
  });

  it('drops unsupported locales and bare subtags', () => {
    expect(getUserLanguages({ languages: ['es-ES', 'xx-ZZ', 'en'] })).toEqual(['es-ES']);
  });

  it('de-duplicates after normalization, keeping first-seen order', () => {
    expect(getUserLanguages({ languages: ['es-ES', 'es-es', 'en-US', 'ES-es'] })).toEqual([
      'es-ES',
      'en-US',
    ]);
  });

  it('ignores non-string junk entries without throwing', () => {
    const languages = ['es-ES', 42, null, undefined, {}, 'en-US'] as unknown as string[];
    expect(getUserLanguages({ languages })).toEqual(['es-ES', 'en-US']);
  });

  it('returns an empty array when languages is absent, empty, or non-array', () => {
    expect(getUserLanguages({})).toEqual([]);
    expect(getUserLanguages({ languages: [] })).toEqual([]);
    expect(getUserLanguages({ languages: undefined })).toEqual([]);
    expect(getUserLanguages(null)).toEqual([]);
    expect(getUserLanguages(undefined)).toEqual([]);
  });

  it('ignores any stray singular language field (removed from User)', () => {
    const strayLanguage: { language: string; languages?: string[] } = { language: 'es-ES' };
    expect(getUserLanguages(strayLanguage)).toEqual([]);
  });
});

describe('getPrimaryLanguage', () => {
  it('returns the first normalized locale from the plural array', () => {
    expect(getPrimaryLanguage({ languages: ['es-es', 'en-US'] })).toBe('es-ES');
  });

  it('skips leading unsupported entries', () => {
    expect(getPrimaryLanguage({ languages: ['xx-ZZ', 'pt-br'] })).toBe('pt-BR');
  });

  it('returns undefined when the user has no supported locale', () => {
    expect(getPrimaryLanguage({})).toBeUndefined();
    expect(getPrimaryLanguage({ languages: ['xx-ZZ'] })).toBeUndefined();
    expect(getPrimaryLanguage(null)).toBeUndefined();
  });
});

describe('coerceToSupportedLocale', () => {
  const hostCatalog = ['en-US', 'es-ES', 'fr-FR'] as const;

  it('returns an exact canonical match from the host catalog', () => {
    expect(coerceToSupportedLocale('es-es', hostCatalog, 'en-US')).toBe('es-ES');
  });

  it('falls back to the closest entry sharing the same base language', () => {
    // `es-MX` is a real Oxy locale, but this host never shipped a Mexican
    // Spanish catalog — its Spanish (Spain) one is the closest match.
    expect(coerceToSupportedLocale('es-MX', hostCatalog, 'en-US')).toBe('es-ES');
  });

  it('falls back to the caller default when no base language matches', () => {
    expect(coerceToSupportedLocale('ja-JP', hostCatalog, 'en-US')).toBe('en-US');
  });

  it('falls back to the caller default for empty or unresolved input', () => {
    expect(coerceToSupportedLocale(undefined, hostCatalog, 'en-US')).toBe('en-US');
    expect(coerceToSupportedLocale(null, hostCatalog, 'en-US')).toBe('en-US');
    expect(coerceToSupportedLocale('', hostCatalog, 'en-US')).toBe('en-US');
  });
});

describe('SUPPORTED_LANGUAGES catalog integrity', () => {
  it('is non-empty', () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(0);
  });

  it('has no duplicate codes', () => {
    const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every entry is internally consistent', () => {
    for (const entry of SUPPORTED_LANGUAGES) {
      // code is canonical language-REGION derived from its subtags
      expect(entry.code).toBe(`${entry.language}-${entry.region}`);
      // base subtag is lowercase, region is uppercase
      expect(entry.language).toBe(entry.language.toLowerCase());
      expect(entry.region).toBe(entry.region.toUpperCase());
      // parsing the code recovers the subtags
      expect(getBaseLanguage(entry.code)).toBe(entry.language);
      // the code round-trips through normalization
      expect(normalizeLocale(entry.code)).toBe(entry.code);
      expect(isSupportedLocale(entry.code)).toBe(true);
      // display names are present
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.nativeName.length).toBeGreaterThan(0);
      // rtl flag agrees with the RTL detector
      expect(isRTLLocale(entry.code)).toBe(entry.rtl === true);
    }
  });
});
