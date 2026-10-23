import type { PropsWithChildren } from 'react';
import { renderHook } from '@testing-library/react';

import { LocaleProvider } from '../locale-context';
import { useTranslation } from '../use-translation';

function translateIn(locale: string) {
  window.localStorage.setItem('oxy_console_locale', locale);
  const wrapper = ({ children }: PropsWithChildren) => <LocaleProvider>{children}</LocaleProvider>;
  return renderHook(() => useTranslation(), { wrapper }).result.current;
}

afterEach(() => window.localStorage.clear());

describe('useTranslation', () => {
  it('reads the locale dictionary when there is one', () => {
    expect(translateIn('es-ES').t('applications.credentials.neverUsed')).toBe('Nunca');
  });

  it('reads English, not the raw key, in a locale without a console dictionary', () => {
    const { t } = translateIn('fr-FR');
    expect(t('applications.credentials.neverUsed')).toBe('Never');
    expect(t('applications.credentials.count', { count: 1 })).toBe('1 credential');
  });

  it('still returns the key for a key that exists nowhere', () => {
    expect(translateIn('en-US').t('no.such.key')).toBe('no.such.key');
  });
});
