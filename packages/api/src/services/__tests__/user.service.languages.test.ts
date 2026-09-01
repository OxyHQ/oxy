/**
 * `updateUserProfile` account-languages handling, asserted on the stored array.
 *
 * `languages` is the ONLY language field — the singular `language` was removed,
 * and a client that still sends it must not cause a write. Accepted values are
 * persisted in the CANONICAL `language-REGION` form with the submitted order
 * preserved and duplicates dropped; anything unsupported is a structured 400.
 *
 * The suite this replaces asserted `doc.set` calls on a mocked document, and
 * proved "rejected before writing" via `expect(mockUser.findById).not
 * .toHaveBeenCalled()`. Both are proxies for the property that matters — what
 * ends up in the `languages` column — so each case here reads it back.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** The value every account starts with, so an unchanged column is visible. */
const SEEDED_LANGUAGES = ['fr-FR'];

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, languages: SEEDED_LANGUAGES });
  return id;
}

async function storedLanguages(userId: string): Promise<string[]> {
  const [row] = await getDb()
    .select({ languages: users.languages })
    .from(users)
    .where(eq(users.id, userId));
  return row.languages;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('accepted locales', () => {
  it('persists a valid array in the submitted order', async () => {
    const id = await makeUser();

    const updated = await userService.updateUserProfile(id, {
      languages: ['en-US', 'es-ES'],
    });

    expect(updated).toBeDefined();
    expect(await storedLanguages(id)).toEqual(['en-US', 'es-ES']);
  });

  it('canonicalizes case and de-dupes, keeping first-seen order', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, { languages: ['EN-us', 'es-ES', 'es-es'] });

    // `es-es` collapses onto the already-seen `es-ES` rather than appending.
    expect(await storedLanguages(id)).toEqual(['en-US', 'es-ES']);
  });

  it('accepts an empty array as "no declared languages"', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, { languages: [] });

    expect(await storedLanguages(id)).toEqual([]);
  });
});

describe('rejected locales leave the column untouched', () => {
  it.each([
    ['a bare, region-less code', ['en']],
    ['an unsupported locale', ['en-US', 'zz-ZZ']],
    ['a non-string entry', [42]],
  ])('rejects %s with a 400', async (_label, languages) => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { languages: languages as string[] })
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(await storedLanguages(id)).toEqual(SEEDED_LANGUAGES);
  });

  it('rejects a non-array value with a 400', async () => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, {
        languages: 'en-US' as unknown as string[],
      })
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(await storedLanguages(id)).toEqual(SEEDED_LANGUAGES);
  });

  it('names the offending field on the error', async () => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { languages: ['zz-ZZ'] })
    ).rejects.toMatchObject({ statusCode: 400, details: { field: 'languages' } });
  });
});

describe('the removed singular `language` field', () => {
  it('is ignored entirely — no write, and `languages` is not derived from it', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      language: 'es-ES',
    } as unknown as { languages?: string[] });

    expect(await storedLanguages(id)).toEqual(SEEDED_LANGUAGES);
  });
});
