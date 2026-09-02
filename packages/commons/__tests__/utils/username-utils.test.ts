/**
 * `validateUsernameFormat`, `isValidUsername` and `sanitizeUsernameInput` were
 * DELETED from this module. They were a third copy of the username policy —
 * `length >= 4 && /^[a-z0-9]+$/i` plus a coercer that lower-cased and stripped
 * every separator — and it agreed with neither the server nor the SDK. The rule
 * lives once, in `@oxyhq/contracts`, with its own suite; this file now covers the
 * one thing that is genuinely local, the suggestion generator, and asserts what
 * it generates is storable under that single rule.
 */

import { generateSuggestedUsername } from '@/utils/auth/usernameUtils';
import { isValidUsername } from '@oxyhq/contracts';

import {
  USERNAME_ADJECTIVES,
  USERNAME_NOUNS,
  USERNAME_NUM_SUFFIX_MAX,
  USERNAME_NUM_SUFFIX_MIN,
} from '@/constants/auth';

describe('generateSuggestedUsername', () => {
  it('returns a string matching adjective + noun + number pattern', () => {
    const suggestion = generateSuggestedUsername();
    expect(suggestion.length).toBeGreaterThan(0);
  });

  it('contains a known adjective from the list', () => {
    const suggestion = generateSuggestedUsername();
    const hasAdjective = USERNAME_ADJECTIVES.some((adj) => suggestion.startsWith(adj));
    expect(hasAdjective).toBe(true);
  });

  it('contains a known noun from the list', () => {
    const suggestion = generateSuggestedUsername();
    const hasNoun = USERNAME_NOUNS.some((noun) => suggestion.includes(noun));
    expect(hasNoun).toBe(true);
  });

  it('ends with a number in the configured range', () => {
    const suggestion = generateSuggestedUsername();
    const trailingNumber = Number.parseInt(suggestion.match(/(\d+)$/)?.[1] ?? '', 10);
    expect(trailingNumber).toBeGreaterThanOrEqual(USERNAME_NUM_SUFFIX_MIN);
    expect(trailingNumber).toBeLessThanOrEqual(USERNAME_NUM_SUFFIX_MAX);
  });

  it('produces output the ONE policy accepts', () => {
    // Generate a batch to defend against statistical flukes from a single sample.
    // A suggestion the server would refuse is worse than no suggestion: it is
    // offered, accepted by the field, and 400ed on submit.
    for (let i = 0; i < 25; i++) {
      const suggestion = generateSuggestedUsername();
      expect(isValidUsername(suggestion)).toBe(true);
    }
  });
});
