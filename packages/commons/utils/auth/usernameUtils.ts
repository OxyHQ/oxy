import {
  USERNAME_ADJECTIVES,
  USERNAME_NOUNS,
  USERNAME_NUM_SUFFIX_MIN,
  USERNAME_NUM_SUFFIX_MAX,
} from '@/constants/auth';

/**
 * Generate a random username suggestion
 *
 * Math.random() is intentional here: this produces a *suggestion* that the user
 * sees and freely edits or replaces. Uniqueness is enforced server-side at
 * registration time. No secret/security boundary depends on this value.
 *
 * @returns A random username suggestion
 */
export function generateSuggestedUsername(): string {
  // Select random adjective and noun
  const adjIndex = Math.floor(Math.random() * USERNAME_ADJECTIVES.length);
  const nounIndex = Math.floor(Math.random() * USERNAME_NOUNS.length);

  // Generate a random number suffix
  const numSuffix = Math.floor(Math.random() * (USERNAME_NUM_SUFFIX_MAX - USERNAME_NUM_SUFFIX_MIN + 1)) + USERNAME_NUM_SUFFIX_MIN;

  const adjective = USERNAME_ADJECTIVES[adjIndex];
  const noun = USERNAME_NOUNS[nounIndex];

  return `${adjective}${noun}${numSuffix}`;
}
