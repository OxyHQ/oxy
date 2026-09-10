import React from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  __resetOxyState,
  __setOxyState,
  __getLanguageMocks,
} from '@/__mocks__/oxy-services';
import { LocaleProvider, useLocale } from '@/lib/i18n/locale-context';
import { DEFAULT_LOCALE } from '@/lib/i18n/types';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

describe('LocaleProvider', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('derives the active locale from the SDK currentLanguage', () => {
    __setOxyState({ currentLanguage: 'es-ES' });
    const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });
    expect(result.current.locale).toBe('es-ES');
  });

  it('coerces a broad SDK locale down to a supported app locale', () => {
    // The account primary es-MX shares its base language with the app's es-ES.
    __setOxyState({ currentLanguage: 'es-MX' });
    const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });
    expect(result.current.locale).toBe('es-ES');
  });

  it('falls back to DEFAULT_LOCALE for a language the app does not ship', () => {
    // Dutch shares no base language with any locale in the app's catalog.
    __setOxyState({ currentLanguage: 'nl-NL' });
    const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });
    expect(result.current.locale).toBe(DEFAULT_LOCALE);
  });

  it('writes the account locales (primary first) when signed in', async () => {
    __setOxyState({
      isAuthenticated: true,
      currentLanguage: 'en-US',
      currentLanguages: ['en-US', 'fr-FR'],
    });
    const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });
    const { updateProfileMutateAsync, setLanguage } = __getLanguageMocks();

    await act(async () => {
      await result.current.setLocale('fr-FR');
    });

    expect(updateProfileMutateAsync).toHaveBeenCalledWith({
      languages: ['fr-FR', 'en-US'],
    });
    expect(setLanguage).not.toHaveBeenCalled();
    expect(result.current.locale).toBe('fr-FR');
  });

  it('stores a guest override via the SDK when signed out', async () => {
    __setOxyState({ isAuthenticated: false, currentLanguage: 'en-US' });
    const { result } = renderHook(() => useLocale(), { wrapper: Wrapper });
    const { updateProfileMutateAsync, setLanguage } = __getLanguageMocks();

    await act(async () => {
      await result.current.setLocale('es-ES');
    });

    expect(setLanguage).toHaveBeenCalledWith('es-ES');
    expect(updateProfileMutateAsync).not.toHaveBeenCalled();
    expect(result.current.locale).toBe('es-ES');
  });

  it('throws when useLocale is called outside a LocaleProvider', () => {
    expect(() => renderHook(() => useLocale())).toThrow(/LocaleProvider/);
  });
});
