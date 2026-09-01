/**
 * `normalizeUsername` is CANONICALIZATION, not policy.
 *
 * The policy left this module — it is `usernameSchema` in `@oxyhq/contracts`,
 * with its own suite. What remains here is the other half: the value the policy
 * is applied TO. The two are tested together below, because the interesting
 * property is the COMPOSITION — normalize, then judge — and in particular that
 * normalizing never turns a name somebody typed into a different one that
 * happens to be legal.
 */

import { isValidUsername } from '@oxyhq/contracts';
import { normalizeUsername } from '../username';

/** Non-breaking space, spelled with an escape so the code point is unambiguous. */
const NBSP = '\u00A0';

/** The composition every write path applies. */
function accepts(raw: string): boolean {
  return isValidUsername(normalizeUsername(raw));
}

describe('normalizeUsername', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeUsername('  alice \n')).toBe('alice');
  });

  it('collapses interior whitespace rather than deleting it, so the value is REJECTED', () => {
    // Silently squashing "al ice" into "alice" would hand the user an account
    // under a name they never chose. It collapses to a single space, which the
    // policy then rejects.
    expect(normalizeUsername('al   ice')).toBe('al ice');
    expect(accepts('al   ice')).toBe(false);
  });

  it('normalizes a non-breaking space (the invisible-collision case)', () => {
    // A trailing NBSP would otherwise store a second "alice" that no human can
    // tell apart from the first.
    expect(normalizeUsername(`alice${NBSP}`)).toBe('alice');
    expect(accepts(`ali${NBSP}ce`)).toBe(false);
  });

  it('NFC-composes, so one name cannot be stored two ways', () => {
    // "á" decomposed is a + U+0301. Both forms render identically; only the
    // composed one should ever reach a unique index — and neither is a legal
    // username, which is the point: normalizing does not rescue it.
    expect(normalizeUsername('a\u0301lice')).toBe('\u00E1lice');
    expect(accepts('a\u0301lice')).toBe(false);
  });

  it('does not lower-case: a capital typed is a capital stored', () => {
    expect(normalizeUsername('MyBot')).toBe('MyBot');
    expect(accepts('MyBot')).toBe(true);
  });
});

describe('the composition accepts what the namespace actually holds', () => {
  it.each(['nate', 'oxy', 'Viacheslav', 'community-maestro', 'alia-production-chat'])(
    'accepts %s',
    (raw) => {
      expect(accepts(raw)).toBe(true);
    }
  );

  it.each(['ab', 'a'.repeat(31), 'al.ice', '-alice', 'alice-', 'a--b', '\u00E1lice', ''])(
    'rejects %j',
    (raw) => {
      expect(accepts(raw)).toBe(false);
    }
  );
});
