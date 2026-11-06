/**
 * Pronouns: a closed list, for a person account only. Asserted on the stored row,
 * the way the other profile writes are.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { userService } from '../user.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function makeUser(kind: 'personal' | 'bot'): Promise<string> {
  const id = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, email: `${id}@example.test`, kind });
  return id;
}

async function storedPronouns(id: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ pronouns: users.pronouns })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row?.pronouns;
}

describe('pronouns', () => {
  it('a person chooses one from the closed list', async () => {
    const id = await makeUser('personal');

    await userService.updateUserProfile(id, { pronouns: 'they_them' });

    expect(await storedPronouns(id)).toBe('they_them');
  });

  it('a bot has none: a change for it is refused and nothing is stored', async () => {
    const id = await makeUser('bot');

    await expect(userService.updateUserProfile(id, { pronouns: 'he_him' })).rejects.toBeInstanceOf(
      BadRequestError,
    );

    expect(await storedPronouns(id)).toBe('unspecified');
  });

  it('a value outside the list is refused', async () => {
    const id = await makeUser('personal');

    await expect(
      userService.updateUserProfile(id, { pronouns: 'Él/Él — free text' }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(await storedPronouns(id)).toBe('unspecified');
  });
});
