/**
 * `character` rides the user DTOs for a `kind: 'bot'` ONLY, through the one
 * shared definer (`userIdentityFields`), and `isAgent` follows `kind`.
 *
 * Paired controls: every non-bot kind is fed the SAME stored character and must
 * still emit none — a serializer that forwarded the column unconditionally
 * would grow every personal payload.
 */

import { randomBytes } from 'node:crypto';
import { formatUserResponse, userIdentityFields, deriveIsAgent } from '../userTransform';
import { userService } from '../../services/user.service';
import { formatProfileResult } from '../../routes/profiles';

const CHARACTER = { preset: 'alfred', bodyColor: '#ffaa00' };

function source(kind: string, ...stored: [] | [unknown]) {
  const character = stored.length ? stored[0] : CHARACTER;
  return {
    _id: randomBytes(12).toString('hex'),
    username: 'luna',
    name: { first: 'Luna' },
    kind,
    type: 'local',
    character,
  };
}

describe('character on the user DTOs', () => {
  it('a bot emits it on every serializer', () => {
    const bot = source('bot');
    expect(userIdentityFields(bot).character).toEqual(CHARACTER);
    expect(formatUserResponse(bot)?.character).toEqual(CHARACTER);
    expect(userService.formatUserResponse(bot as never).character).toEqual(CHARACTER);
    expect(formatProfileResult(bot as never).character).toEqual(CHARACTER);
  });

  it.each(['personal', 'organization', 'project', 'channel'])(
    '%s never emits it, even if a character is stored',
    (kind) => {
      const row = source(kind);
      expect(userIdentityFields(row)).not.toHaveProperty('character');
      expect(formatUserResponse(row)).not.toHaveProperty('character');
      expect(userService.formatUserResponse(row as never)).not.toHaveProperty('character');
      expect(formatProfileResult(row as never)).not.toHaveProperty('character');
    },
  );

  it('a bot without a stored (or with a malformed) character omits the key', () => {
    for (const stored of [null, undefined, { shape: 'heart' }, 'x']) {
      expect(formatUserResponse(source('bot', stored))).not.toHaveProperty('character');
    }
  });
});

describe('isAgent', () => {
  it('derives from kind, not type', () => {
    expect(deriveIsAgent('bot')).toBe(true);
    expect(deriveIsAgent('personal')).toBe(false);
    expect(deriveIsAgent(undefined)).toBe(false);
    expect(formatProfileResult(source('bot') as never).isAgent).toBe(true);
    expect(formatProfileResult({ ...source('personal'), type: 'agent' } as never).isAgent).toBe(
      false,
    );
  });
});
