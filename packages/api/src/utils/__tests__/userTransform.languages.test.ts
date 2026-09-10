/**
 * `formatUserResponse` account-languages serialization.
 *
 * The DTO emits ONLY the plural `languages` array (there is no singular
 * `language`). `getUserLanguages` normalizes to canonical BCP-47 locales,
 * drops unsupported entries, and de-duplicates. Output stays valid against the
 * canonical `@oxy.so/contracts` user-response contract (passthrough).
 */

import { formatUserResponse } from '../userTransform';
import { userResponseSchema, safeParseContract } from '@oxy.so/contracts';

const ID = '507f1f77bcf86cd799439021';

describe('formatUserResponse — account languages', () => {
  it('emits the normalized languages array and no singular `language`', () => {
    const formatted = formatUserResponse({
      _id: { toString: () => ID },
      username: 'multi',
      languages: ['en-US', 'es-ES'],
    });

    expect(formatted?.languages).toEqual(['en-US', 'es-ES']);
    expect(formatted && 'language' in formatted).toBe(false);
    expect(safeParseContract(userResponseSchema, formatted)).not.toBeNull();
  });

  it('canonicalizes case, drops unsupported entries and de-dupes', () => {
    const formatted = formatUserResponse({
      _id: { toString: () => ID },
      username: 'messy',
      languages: ['EN-us', 'es-ES', 'xx-XX', 'es-ES'],
    });

    expect(formatted?.languages).toEqual(['en-US', 'es-ES']);
  });

  it('does NOT read a legacy singular `language` field (languages is the only source)', () => {
    const formatted = formatUserResponse({
      _id: { toString: () => ID },
      username: 'legacy',
      language: 'es-ES',
    });

    // No `languages` array → empty result; the singular field is ignored.
    expect(formatted?.languages).toEqual([]);
  });

  it('emits an empty array when the account has no languages', () => {
    const formatted = formatUserResponse({
      _id: { toString: () => ID },
      publicKey: '0xabc',
    });

    expect(formatted?.languages).toEqual([]);
    expect(safeParseContract(userResponseSchema, formatted)).not.toBeNull();
  });
});
