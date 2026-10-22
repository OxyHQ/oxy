import * as client from '../client';
import {
  CONSOLE_TERMS_VERSION,
  CONSOLE_USE_CASES,
  acceptConsoleTermsInputSchema,
  consoleOnboardingStateSchema,
  saveConsoleUseCasesInputSchema,
} from '../index';

describe('console onboarding contract', () => {
  it('shares one terms version and use-case list between the root and client entries', () => {
    expect(client.CONSOLE_TERMS_VERSION).toBe(CONSOLE_TERMS_VERSION);
    expect(client.CONSOLE_USE_CASES).toBe(CONSOLE_USE_CASES);
    expect(CONSOLE_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires both acknowledgements to be literally true', () => {
    const base = {
      version: CONSOLE_TERMS_VERSION,
      marketingOptIn: false,
      adultAcknowledged: true,
      aupAcknowledged: true,
    };
    const ok = (input: object) => acceptConsoleTermsInputSchema.safeParse(input).success;
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, adultAcknowledged: false })).toBe(false);
    expect(ok({ ...base, aupAcknowledged: false })).toBe(false);
    const { aupAcknowledged: _omitted, ...withoutAup } = base;
    expect(ok(withoutAup)).toBe(false);
  });

  it('accepts an empty use-case list, de-duplicates, and rejects unknown ids', () => {
    expect(saveConsoleUseCasesInputSchema.parse({ useCases: [] }).useCases).toEqual([]);
    expect(
      saveConsoleUseCasesInputSchema.parse({ useCases: ['ai-models', 'ai-models'] }).useCases,
    ).toEqual(['ai-models']);
    expect(saveConsoleUseCasesInputSchema.safeParse({ useCases: ['nope'] }).success).toBe(false);
  });

  it('trims the description and bounds it at 2000 characters', () => {
    expect(
      saveConsoleUseCasesInputSchema.parse({ useCases: [], description: '  hello  ' }).description,
    ).toBe('hello');
    expect(
      saveConsoleUseCasesInputSchema.safeParse({ useCases: [], description: 'a'.repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      saveConsoleUseCasesInputSchema.safeParse({ useCases: [], description: 'a'.repeat(2001) })
        .success,
    ).toBe(false);
  });

  it('describes the empty state', () => {
    expect(
      consoleOnboardingStateSchema.safeParse({
        termsVersion: null,
        termsAcceptedAt: null,
        termsCurrent: false,
        marketingOptIn: false,
        useCases: [],
        useCaseDescription: null,
        useCasesAnswered: false,
      }).success,
    ).toBe(true);
  });
});
