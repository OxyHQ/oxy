import {
  canAcceptTerms,
  deriveOnboardingStep,
  normalizeDescription,
  toggleUseCase,
  USE_CASE_DESCRIPTION_MAX_LENGTH,
} from '../onboarding';

describe('deriveOnboardingStep', () => {
  it('asks for the terms first, even when use cases were answered under an older version', () => {
    expect(deriveOnboardingStep({ termsCurrent: false, useCasesAnswered: true })).toBe('terms');
    expect(deriveOnboardingStep({ termsCurrent: false, useCasesAnswered: false })).toBe('terms');
  });

  it('asks the question once the terms are current', () => {
    expect(deriveOnboardingStep({ termsCurrent: true, useCasesAnswered: false })).toBe('use-cases');
  });

  it('is done when both are answered', () => {
    expect(deriveOnboardingStep({ termsCurrent: true, useCasesAnswered: true })).toBe('done');
  });
});

describe('canAcceptTerms', () => {
  it('needs both required boxes', () => {
    expect(canAcceptTerms({ adult: true, aup: true })).toBe(true);
    expect(canAcceptTerms({ adult: true, aup: false })).toBe(false);
    expect(canAcceptTerms({ adult: false, aup: true })).toBe(false);
    expect(canAcceptTerms({ adult: false, aup: false })).toBe(false);
  });
});

describe('normalizeDescription', () => {
  it('treats blank as absent', () => {
    expect(normalizeDescription('   \n ')).toBeUndefined();
  });

  it('trims', () => {
    expect(normalizeDescription('  ship an app ')).toBe('ship an app');
  });

  it('caps at the limit', () => {
    const out = normalizeDescription('a'.repeat(USE_CASE_DESCRIPTION_MAX_LENGTH + 50));
    expect(out).toHaveLength(USE_CASE_DESCRIPTION_MAX_LENGTH);
  });
});

describe('toggleUseCase', () => {
  it('adds in catalogue order and removes on a second toggle', () => {
    const a = toggleUseCase([], 'publish-apps');
    const b = toggleUseCase(a, 'build-with-api');
    expect(b).toEqual(['build-with-api', 'publish-apps']);
    expect(toggleUseCase(b, 'publish-apps')).toEqual(['build-with-api']);
  });
});
