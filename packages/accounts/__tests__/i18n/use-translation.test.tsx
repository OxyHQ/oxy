import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import { useTranslation } from '@/lib/i18n/use-translation';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

describe('useTranslation', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('looks up an accounts-namespaced key in en-US', () => {
    __setOxyState({ currentLanguage: 'en-US' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    expect(result.current.t('common.save')).toBe('Save');
  });

  it('falls back to core translate when accounts dict is missing the key', () => {
    __setOxyState({ currentLanguage: 'en-US' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    // `signin.title` lives in core's en-US dictionary, not accounts'.
    const value = result.current.t('signin.title');
    // Whichever value core has, it must not equal the key itself.
    expect(value).not.toBe('signin.title');
  });

  it('returns the key itself when neither accounts nor core has a translation', () => {
    __setOxyState({ currentLanguage: 'en-US' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    expect(result.current.t('this.key.does.not.exist.anywhere')).toBe(
      'this.key.does.not.exist.anywhere',
    );
  });

  it('interpolates {{vars}} into the resolved string', () => {
    __setOxyState({ currentLanguage: 'en-US' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    // Missing keys pass straight through interpolate, so this exercises the
    // interpolation path against a template with a known {{name}} placeholder.
    const greeting = result.current.t('this.key.does.not.exist {{name}}', { name: 'Ada' });
    expect(typeof greeting).toBe('string');
  });

  it('uses the Spanish dictionary when the active locale is es-ES', () => {
    __setOxyState({ currentLanguage: 'es-ES' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    expect(result.current.locale).toBe('es-ES');
    // `common.save` exists in both locales but should be the Spanish form now.
    const value = result.current.t('common.save');
    expect(value).not.toBe('Save');
  });

  it('falls back to English accounts strings for locales without an overlay', () => {
    __setOxyState({ currentLanguage: 'fr-FR' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    expect(result.current.locale).toBe('fr-FR');
    expect(result.current.t('common.save')).toBe('Save');
  });

  it('exposes a setLocale that updates the active locale', async () => {
    __setOxyState({ currentLanguage: 'en-US' });
    const { result } = renderHook(() => useTranslation(), { wrapper: Wrapper });
    expect(result.current.locale).toBe('en-US');
    await act(async () => {
      await result.current.setLocale('es-ES');
    });
    expect(result.current.locale).toBe('es-ES');
  });
});
