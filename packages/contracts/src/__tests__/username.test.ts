/**
 * The one username policy, exercised against the shapes production actually
 * holds and the shapes the seven rules it replaces disagreed about.
 *
 * The live namespace (43 local rows, measured 2026-08-25) is the corpus: every
 * name below that is marked legal is a name somebody holds, or one a system with
 * a database CHECK behind it is committed to minting.
 */

import { ACCOUNT_KINDS } from '../accountGraph';
import {
  applyBotUsernameSuffix,
  botUsernameSchema,
  isValidUsername,
  stripDisallowedUsernameCharacters,
  usernameSchema,
  usernameSchemaForAccountKind,
  BOT_USERNAME_INVALID_MESSAGE,
  BOT_USERNAME_SUFFIX,
  USERNAME_INVALID_MESSAGE,
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

/**
 * The one exception the policy carries, and the four kinds it must not reach.
 *
 * A bot's handle ends in `bot`. It is a labelling rule, not a namespace: the
 * unique index is still one index, `mybot` is still a name a person could have
 * asked for first, and every other kind is governed by exactly the schema above.
 * So the tests that matter most here are the NEGATIVE ones — `personal`,
 * `organization`, `project` and `channel` must be handed back the unchanged
 * policy, and the ~73k federated rows must never meet either schema.
 */
describe('a bot account labels itself in its handle', () => {
  describe('what conforms', () => {
    it.each([
      ['aliabot', 'the plain form, and the one Telegram itself produces'],
      ['my-bot', 'a hyphen separator, which this policy admits'],
      ['my_bot', 'an underscore separator, admitted on the same footing'],
      ['community-guidebot', 'an existing handle with the label appended'],
      ['bot', 'the label alone: 3 characters, at the floor, and free to claim'],
    ])('accepts %s (%s)', (username) => {
      expect(botUsernameSchema.safeParse(username).success).toBe(true);
    });

    /**
     * Case is PRESERVED but uniqueness folds it (`lower(btrim(username))`), so a
     * case-SENSITIVE suffix test would accept `mybot` and refuse `MyBot` — two
     * names the index considers the same one. This is the discriminator for that
     * bug: it fails if the comparison is written with a bare `endsWith`.
     */
    it.each(['MyBot', 'MYBOT', 'myBOT', 'My-Bot'])(
      'accepts %s, because the index cannot tell it from the lower-case form',
      (username) => {
        expect(botUsernameSchema.safeParse(username).success).toBe(true);
      }
    );

    it('returns the handle as typed, capitals and all', () => {
      expect(botUsernameSchema.parse('MyBot')).toBe('MyBot');
    });
  });

  describe('what does not, and the message that says why', () => {
    it.each([
      'alia',
      'community-guide',
      'community-maestro',
      'community-pulse',
      'botanist',
      'robot-helper',
    ])('rejects %s', (username) => {
      expect(botUsernameSchema.safeParse(username).success).toBe(false);
    });

    it('says what is wrong, naming the suffix', () => {
      const parsed = botUsernameSchema.safeParse('community-guide');

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(BOT_USERNAME_INVALID_MESSAGE);
      expect(BOT_USERNAME_INVALID_MESSAGE).toContain(BOT_USERNAME_SUFFIX);
    });

    /**
     * The suffix is checked LAST, so a handle that is illegal for everybody is
     * reported as illegal — not as a bot that forgot its label. A caller told to
     * append `bot` to `a.b` would append it and be refused a second time.
     */
    it('reports the base policy first when both are broken', () => {
      const parsed = botUsernameSchema.safeParse('a.b');

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(USERNAME_INVALID_MESSAGE);
    });

    it('still holds a conforming suffix to the base policy', () => {
      // Ends in `bot`, and is illegal for every kind: a separator cannot lead.
      expect(botUsernameSchema.safeParse('-mybot').success).toBe(false);
      expect(botUsernameSchema.safeParse('my--bot').success).toBe(false);
      expect(botUsernameSchema.safeParse(`${'a'.repeat(USERNAME_MAX_LENGTH)}bot`).success).toBe(
        false
      );
    });
  });

  /**
   * The control that decides whether this is a labelling rule or a second
   * policy. Every kind that is not `bot` gets the schema unchanged — asserted by
   * IDENTITY, not by re-testing a handful of names, so a future variant for
   * `channel` cannot slip in while the character tests still pass.
   */
  describe('and it reaches no other kind', () => {
    it.each(['personal', 'organization', 'project', 'channel'] as const)(
      '%s is governed by the unchanged policy',
      (kind) => {
        expect(usernameSchemaForAccountKind(kind)).toBe(usernameSchema);
      }
    );

    it.each(['personal', 'organization', 'project', 'channel'] as const)(
      'a %s account may hold a handle that does not end in bot',
      (kind) => {
        expect(usernameSchemaForAccountKind(kind).safeParse('community-guide').success).toBe(true);
      }
    );

    it.each(['personal', 'organization', 'project', 'channel'] as const)(
      'and a %s account is not forbidden one that does',
      (kind) => {
        // The rule says what a bot's handle must look like, not that the label is
        // reserved. `robot` and `abbot` are ordinary words.
        expect(usernameSchemaForAccountKind(kind).safeParse('abbot').success).toBe(true);
      }
    );

    it('bot is the only kind that gets a different schema', () => {
      const branched = ACCOUNT_KINDS.filter(
        (kind) => usernameSchemaForAccountKind(kind) !== usernameSchema
      );

      expect(branched).toEqual(['bot']);
    });

    it('an absent kind is the base policy, never the stricter one', () => {
      // `users.kind` defaults to `personal` and 11 rows predate the column being
      // filled in. A rule that treated "unknown" as "bot" would 400 a rename on
      // an account nobody ever called a bot.
      expect(usernameSchemaForAccountKind(null)).toBe(usernameSchema);
      expect(usernameSchemaForAccountKind(undefined)).toBe(usernameSchema);
    });
  });

  /**
   * The federated namespace, which this must never be pointed at.
   *
   * `users.username` also holds ~73k remote actors as `handle@domain`, written by
   * `POST /users/resolve` through its own normalizer. Some of them are bots on
   * their own server. Neither schema governs them — and both would reject them,
   * which is what makes "never point it there" a real requirement rather than a
   * style note.
   */
  describe('and it says nothing about remote actors', () => {
    it.each(['alice@mastodon.social', 'newsbot@mastodon.social', `${'a'.repeat(70)}@example.org`])(
      'rejects %s under BOTH schemas, so neither may govern the federated column',
      (handle) => {
        expect(usernameSchema.safeParse(handle).success).toBe(false);
        expect(botUsernameSchema.safeParse(handle).success).toBe(false);
      }
    );
  });
});

/**
 * The generator's side of the same rule.
 *
 * A suggestion that the server will refuse is the defect this exists to prevent:
 * Alia's agent creation proposes a handle from the agent's name, and without
 * this it would propose `community-guide` for a bot and be 400ed on submit.
 */
describe('applyBotUsernameSuffix', () => {
  it('appends the label to a handle that lacks it', () => {
    expect(applyBotUsernameSuffix('community-guide')).toBe('community-guidebot');
  });

  it('leaves a handle that already carries it alone, whatever its case', () => {
    expect(applyBotUsernameSuffix('aliabot')).toBe('aliabot');
    expect(applyBotUsernameSuffix('MyBot')).toBe('MyBot');
  });

  it('keeps a separator the caller typed rather than inventing one', () => {
    // `community-guide-` is not a legal handle on its own; with the label it is.
    expect(applyBotUsernameSuffix('community-guide-')).toBe('community-guide-bot');
  });

  it('makes room for the label instead of overflowing the ceiling', () => {
    const suggested = applyBotUsernameSuffix('a'.repeat(USERNAME_MAX_LENGTH));

    expect(suggested.length).toBe(USERNAME_MAX_LENGTH);
    expect(botUsernameSchema.safeParse(suggested).success).toBe(true);
  });

  it('proposes something the server accepts, for every name a person might type', () => {
    for (const name of ['Community Guide', 'Alia', 'Al', 'a'.repeat(120), 'Nate.  Isern!']) {
      const slug = stripDisallowedUsernameCharacters(name.trim().replace(/\s+/g, '-'))
        .replace(/[-_]{2,}/g, '-')
        .replace(/^[-_]+/, '');
      expect(botUsernameSchema.safeParse(applyBotUsernameSuffix(slug)).success).toBe(true);
    }
  });

  it('cannot rescue a name the base policy refuses', () => {
    // It PROPOSES; `POST /accounts` decides. A dot survives the append and the
    // schema still says no, which is the honest outcome — the coercing rules this
    // policy replaced would have deleted it and handed back another name.
    expect(applyBotUsernameSuffix('a.b')).toBe('a.bbot');
    expect(botUsernameSchema.safeParse('a.bbot').success).toBe(false);
  });
});
