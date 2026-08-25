/**
 * The one username policy, exercised against the shapes production actually
 * holds and the shapes the seven rules it replaces disagreed about.
 *
 * The live namespace (43 local rows, measured 2026-08-25) is the corpus: every
 * name below that is marked legal is a name somebody holds, or one a system with
 * a database CHECK behind it is committed to minting.
 */

import {
  isValidUsername,
  stripDisallowedUsernameCharacters,
  usernameSchema,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../username';

describe('usernameSchema', () => {
  describe('names that exist today stay legal', () => {
    it.each([
      // Personal accounts.
      'nate',
      'natex',
      'lady',
      'coolroad168',
      'zestfulbridge634',
      // Case is preserved, not folded: this account holds a capital.
      'Viacheslav',
      // Organizations and projects. `oxy` is what sets the 3-character floor.
      'oxy',
      'faircoin',
      'mention',
      'homiio',
      'notasdenate',
      // The four hyphenated accounts. Every one is minted by the managed-account
      // path, and `alia-production-chat` is a cost-centre slug.
      'alia-production-chat',
      'community-guide',
      'community-maestro',
      'community-pulse',
    ])('accepts %s', (username) => {
      expect(usernameSchema.safeParse(username).success).toBe(true);
    });

    /**
     * The cost-centre slugs are the reason hyphens are in the policy at all:
     * `internal_cost_centers_slug_check` permits them and the seed turns the slug
     * into a username. `internalCostCenterSpecs.test.ts` asserts the live list;
     * this pins the SHAPE, so tightening the policy fails here too.
     */
    it.each(['alia-production-chat', 'codea', 'alia-research', 'alia-voice', 'alia-evaluations'])(
      'accepts the cost-centre slug %s',
      (slug) => {
        expect(usernameSchema.safeParse(slug).success).toBe(true);
      }
    );
  });

  describe('the characters', () => {
    it.each(['a-b', 'a_b', 'my-bot-2', 'my_bot_2', 'a-b_c'])('accepts %s', (username) => {
      expect(usernameSchema.safeParse(username).success).toBe(true);
    });

    it.each([
      ['a.b', 'a dot is the handle/domain delimiter and the strongest confusable'],
      ['al ice', 'interior whitespace would break URL routing'],
      ['alice!', 'punctuation'],
      ['alice@oxy.so', 'the federated form belongs to another namespace'],
      ['añejo', 'non-ASCII'],
      ['ali ce', 'a non-breaking space is invisible, and would produce two identical-looking accounts'],
    ])('rejects %s (%s)', (username) => {
      expect(usernameSchema.safeParse(username).success).toBe(false);
    });
  });

  describe('the edges', () => {
    it.each(['-alice', '_alice', 'alice-', 'alice_'])(
      'rejects %s: a handle starts and ends alphanumeric',
      (username) => {
        expect(usernameSchema.safeParse(username).success).toBe(false);
      }
    );

    it.each(['a--b', 'a__b', 'a-_b', 'a_-b'])(
      'rejects %s: never two separators in a row',
      (username) => {
        expect(usernameSchema.safeParse(username).success).toBe(false);
      }
    );
  });

  describe('the length bound, which the account path used to lack entirely', () => {
    it('rejects a name below the floor', () => {
      expect(usernameSchema.safeParse('ok').success).toBe(false);
    });

    it('accepts a name exactly at the floor', () => {
      expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH)).success).toBe(true);
    });

    it('accepts a name exactly at the ceiling', () => {
      expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
    });

    it('rejects a name one past the ceiling', () => {
      expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
    });

    it('rejects the 200-character name the unbounded account rule would have stored', () => {
      expect(usernameSchema.safeParse('a'.repeat(200)).success).toBe(false);
    });

    it('rejects the single character the unbounded account rule would have stored', () => {
      expect(usernameSchema.safeParse('a').success).toBe(false);
    });
  });

  describe('case is preserved, never folded', () => {
    it('returns the name as typed', () => {
      expect(usernameSchema.parse('MyBot')).toBe('MyBot');
    });

    it('returns a mixed-case existing name unchanged', () => {
      expect(usernameSchema.parse('Viacheslav')).toBe('Viacheslav');
    });
  });

  describe('surrounding whitespace is a typo; interior whitespace is not', () => {
    it('trims the edges', () => {
      expect(usernameSchema.parse('  alice \n')).toBe('alice');
    });

    it('does not silently join a name that was typed with a space in it', () => {
      expect(usernameSchema.safeParse('  al ice  ').success).toBe(false);
    });
  });
});

describe('isValidUsername', () => {
  it('answers from the schema, so an inline check and a 400 cannot disagree', () => {
    for (const candidate of ['nate', 'community-guide', 'a.b', '-alice', 'ok', 'a'.repeat(31)]) {
      expect(isValidUsername(candidate)).toBe(usernameSchema.safeParse(candidate).success);
    }
  });
});

describe('stripDisallowedUsernameCharacters', () => {
  it('drops what the policy forbids', () => {
    expect(stripDisallowedUsernameCharacters('a.b c!d')).toBe('abcd');
  });

  it('preserves case, unlike the three coercing rules it replaces', () => {
    expect(stripDisallowedUsernameCharacters('MyBot')).toBe('MyBot');
  });

  it('keeps the separators the policy admits', () => {
    expect(stripDisallowedUsernameCharacters('my-bot_2')).toBe('my-bot_2');
  });

  /**
   * The point of the split: filtering keystrokes is not validating. A stripped
   * value can still be illegal, and it must then FAIL with a message rather than
   * be quietly repaired into some other name.
   */
  it('does not repair a name it cannot fix', () => {
    expect(stripDisallowedUsernameCharacters('-alice-')).toBe('-alice-');
    expect(isValidUsername('-alice-')).toBe(false);
  });
});
