import {
  AVATAR_PICKABLE_SHAPES,
  avatarCharacterFor,
  avatarCharacterSchema,
  createAccountRequestSchema,
  parseAvatarCharacter,
  userResponseSchema,
} from '../index';

describe('avatarCharacterSchema', () => {
  it('accepts a preset or a shape, and nothing else', () => {
    expect(parseAvatarCharacter({ preset: 'alfred' })).toEqual({ preset: 'alfred' });
    expect(parseAvatarCharacter({ shape: 'heart', eyes: 'oval', eyeSpacing: 1.2 })).toEqual({
      shape: 'heart',
      eyes: 'oval',
      eyeSpacing: 1.2,
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'alfred'],
    ['an empty object', {}],
    ['a paint without a shape', { color: 'pink' }],
    // The account's colour paints a bot: a character has no paint of its own.
    ['a named paint', { shape: 'heart', color: 'pink' }],
    ['a free paint', { shape: 'heart', bodyColor: '#ffaa00' }],
    ['an unknown key', { preset: 'alfred', selections: { color: 'blue' } }],
    ['a non id-like value', { preset: 'Alfred!' }],
    ['eyeSpacing below range', { preset: 'alfred', eyeSpacing: 0.4 }],
    ['eyeSpacing above range', { preset: 'alfred', eyeSpacing: 1.6 }],
    ['a non-finite eyeSpacing', { preset: 'alfred', eyeSpacing: Number.NaN }],
  ])('refuses %s', (_label, value) => {
    expect(parseAvatarCharacter(value)).toBeNull();
    expect(avatarCharacterSchema.safeParse(value).success).toBe(false);
  });
});

describe('avatarCharacterFor', () => {
  it('is stable per seed and always valid', () => {
    expect(avatarCharacterFor('luna-bot')).toEqual(avatarCharacterFor('luna-bot'));
    for (const seed of ['a', 'luna-bot', 'verity-bot', 'x'.repeat(40)]) {
      const character = avatarCharacterFor(seed);
      expect(parseAvatarCharacter(character)).toEqual(character);
      expect(AVATAR_PICKABLE_SHAPES).toContain(character.shape);
      expect(character).not.toHaveProperty('color');
      expect(character).not.toHaveProperty('bodyColor');
    }
  });

  it('varies across seeds', () => {
    const looks = new Set(
      Array.from({ length: 60 }, (_, i) => JSON.stringify(avatarCharacterFor(`bot-${i}`))),
    );
    expect(looks.size).toBeGreaterThan(10);
  });
});

describe('createAccountRequestSchema — character', () => {
  const base = { username: 'lunabot', name: { displayName: 'Luna' } };

  it('accepts a character on a bot, and none', () => {
    expect(
      createAccountRequestSchema.safeParse({
        ...base,
        kind: 'bot',
        character: { preset: 'alfred' },
      }).success,
    ).toBe(true);
    expect(createAccountRequestSchema.safeParse({ ...base, kind: 'bot' }).success).toBe(true);
  });

  it('refuses a character on any other kind', () => {
    for (const kind of ['organization', 'project', 'channel'] as const) {
      const parsed = createAccountRequestSchema.safeParse({
        ...base,
        kind,
        character: { preset: 'alfred' },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('refuses a malformed character on a bot', () => {
    expect(
      createAccountRequestSchema.safeParse({ ...base, kind: 'bot', character: { color: 'pink' } })
        .success,
    ).toBe(false);
  });
});

describe('userResponseSchema — character', () => {
  it('carries a bot character and still parses a personal payload without one', () => {
    expect(
      userResponseSchema.safeParse({
        id: 'a',
        name: {},
        kind: 'bot',
        character: { preset: 'alfred' },
      }).success,
    ).toBe(true);
    expect(userResponseSchema.safeParse({ id: 'a', name: {}, kind: 'personal' }).success).toBe(
      true,
    );
    expect(
      userResponseSchema.safeParse({ id: 'a', name: {}, kind: 'bot', character: { x: 1 } }).success,
    ).toBe(false);
  });
});
