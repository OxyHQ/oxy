import { classifyNativeProductAgentDisplayName } from '../nativeProductAgentAccountPlan';

const legacyHomiio = {
  adoptedLegacyAccount: true,
  expectedDisplayName: 'Homiio',
  storedDisplayName: null,
  storedFirstName: 'Homiio',
  storedLastName: null,
} as const;

describe('native product-agent account planning', () => {
  it('accepts an exact explicit display name without a write', () => {
    expect(
      classifyNativeProductAgentDisplayName({
        ...legacyHomiio,
        storedDisplayName: 'Homiio',
      }),
    ).toBe('exact');
  });

  it('normalizes only an adopted legacy account with the same effective title', () => {
    expect(classifyNativeProductAgentDisplayName(legacyHomiio)).toBe(
      'normalize_legacy',
    );
  });

  it.each([
    { adoptedLegacyAccount: false },
    { storedDisplayName: '' },
    { storedFirstName: 'Different' },
    { storedLastName: 'Account' },
  ])('fails closed for a non-equivalent state: %j', (override) => {
    expect(
      classifyNativeProductAgentDisplayName({
        ...legacyHomiio,
        ...override,
      }),
    ).toBe('drift');
  });
});
