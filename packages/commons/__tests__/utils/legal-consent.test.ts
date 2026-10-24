/**
 * The onboarding consent sentence links the real documents. It used to be one
 * plain string, "I agree with Oxy User Terms And Conditions and acknowledge the
 * Privacy notice", with nothing to tap.
 */
import {
  consentPlainText,
  PRIVACY_POLICY_URL,
  splitConsentText,
  TERMS_OF_SERVICE_URL,
} from '@/lib/legal';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

describe('the consent sentence', () => {
  it.each([
    ['en', en.auth.welcome.termsAgree],
    ['es', es.auth.welcome.termsAgree],
  ])('%s links both documents exactly once', (_locale, sentence) => {
    const links = splitConsentText(sentence).filter((segment) => segment.link);
    expect(links.map((segment) => segment.link)).toEqual(['terms', 'privacy']);
    expect(links.every((segment) => segment.text.length > 0)).toBe(true);
    expect(consentPlainText(sentence)).not.toMatch(/[<>]/);
  });

  it('splits text and links in order', () => {
    expect(splitConsentText('A <terms>T</terms> b <privacy>P</privacy>.')).toEqual([
      { text: 'A ' },
      { text: 'T', link: 'terms' },
      { text: ' b ' },
      { text: 'P', link: 'privacy' },
      { text: '.' },
    ]);
  });

  it('keeps an unknown or unclosed tag as text rather than dropping words', () => {
    expect(consentPlainText('A <terms>T and <other>x</other>')).toBe(
      'A <terms>T and <other>x</other>',
    );
  });

  it('points at the documents the SDK sign-in screen links', () => {
    expect(TERMS_OF_SERVICE_URL).toBe(
      'https://oxy.so/company/transparency/policies/terms-of-service',
    );
    expect(PRIVACY_POLICY_URL).toBe('https://oxy.so/company/transparency/policies/privacy');
  });
});
