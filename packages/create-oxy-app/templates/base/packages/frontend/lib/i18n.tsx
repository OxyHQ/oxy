import { createContext, useContext, useMemo, type ReactNode } from 'react';

// Minimal, dependency-free i18n. Synchronous by design — no suspense — so it is
// safe to mount at the root of the provider tree. Swap in i18next later if the
// app grows to need pluralization / interpolation / lazy locale loading.

// Keys follow the Oxy convention (ADR 0055): nested objects of identifier
// segments, read as a dotted path (`t('home.title')`), never the English text.
type Messages = { [segment: string]: string | Messages };

const en: Messages = {
  home: {
    title: '{{APP_NAME}}',
    subtitle: 'Built with the Oxy SDK.',
    signedInAs: 'Signed in as',
  },
  auth: {
    title: 'Welcome to {{APP_NAME}}',
    subtitle: 'Sign in with your Oxy account to continue.',
  },
};

function lookup(messages: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

const locales: Record<string, Messages> = { en };

interface I18nValue {
  locale: string;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const full = typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : 'en-US';
    const base = full.split('-')[0];
    const messages = locales[base] ?? en;
    return { locale: full, t: (key) => lookup(messages, key) ?? lookup(en, key) ?? key };
  }, []);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation must be used within <LocaleProvider>');
  }
  return ctx;
}
