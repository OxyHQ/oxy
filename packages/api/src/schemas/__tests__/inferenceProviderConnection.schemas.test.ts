import { describe, expect, it } from 'bun:test';

import {
  providerCredentialBody,
  providerConnectionRotateBody,
} from '../inferenceProviderConnection.schemas';

describe('provider credential transport boundary', () => {
  const create = {
    provider: 'openai',
    environment: 'production' as const,
    secret: 'customer-provider-key_123',
  };

  it('accepts an opaque visible-ASCII provider key for create and rotate', () => {
    expect(providerCredentialBody.safeParse(create).success).toBe(true);
    expect(
      providerConnectionRotateBody.safeParse({ secret: create.secret }).success,
    ).toBe(true);
  });

  for (const [name, secret] of [
    ['NUL control byte', 'valid\0tail'],
    ['newline', 'valid\ntail'],
    ['tab', 'valid\ttail'],
    ['surrounding whitespace', ' customer-provider-key '],
    ['non-ASCII', 'credencial-ñ'],
  ] as const) {
    it(`refuses ${name} before Kaana custody`, () => {
      expect(
        providerCredentialBody.safeParse({ ...create, secret }).success,
      ).toBe(false);
      expect(providerConnectionRotateBody.safeParse({ secret }).success).toBe(
        false,
      );
    });
  }
});
