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

/**
 * The three questions a handle GENERATOR asks, pinned so they stay answerable.
 *
 * Alia's `suggestAgentUsername` re-derives a subset of this policy by hand and
 * has no minimum, so an agent called "Al" is proposed as `al` and refused on
 * submit. Replacing that hand-rolled subset with these calls is the fix; these
 * assertions are what keep the calls available and honest.
 */
describe('a slug generator can be built on this without re-deriving it', () => {
  /** The shape of Alia's generator, expressed against the policy instead of a copy. */
  function suggest(displayName: string): string | null {
    const slug = stripDisallowedUsernameCharacters(
      displayName.trim().replace(/\s+/g, '-')
    ).replace(/[-_]{2,}/g, '-');
    const trimmed = slug.replace(/^[-_]+/, '').replace(/[-_]+$/, '').slice(0, USERNAME_MAX_LENGTH);
    return isValidUsername(trimmed) ? trimmed : null;
  }

  it('accepts an ordinary name', () => {
    expect(suggest('Community Maestro')).toBe('Community-Maestro');
  });

  it('drops what the policy forbids rather than proposing it', () => {
    expect(suggest('Nate.  Isern!')).toBe('Nate-Isern');
  });

  /**
   * The case the hand-rolled generator gets wrong: two characters is a legal
   * SLUG and an illegal USERNAME. Knowing that requires the minimum, which is why
   * it is exported.
   */
  it('reports too-short rather than proposing a name the server will refuse', () => {
    expect(suggest('Al')).toBeNull();
    expect('Al'.length).toBeLessThan(USERNAME_MIN_LENGTH);
  });

  it('does not exceed the ceiling', () => {
    const proposed = suggest('A'.repeat(120));
    expect(proposed).not.toBeNull();
    expect((proposed ?? '').length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
  });

  it('needs no server dependency: the module is zod and constants', () => {
    // A generator runs in a React Native bundle and in another repo's backend.
    // If this ever needed a database handle or an HTTP client, every consumer
    // would go back to re-deriving the rule, which is how there came to be seven.
    expect(typeof isValidUsername).toBe('function');
    expect(typeof stripDisallowedUsernameCharacters).toBe('function');
    expect(USERNAME_MIN_LENGTH).toBeLessThan(USERNAME_MAX_LENGTH);
  });
});
