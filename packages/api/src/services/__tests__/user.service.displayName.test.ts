/**
 * The native display-name character policy at the profile write path.
 *
 * `cleanDisplayName` allows letters, combining marks, spaces and the apostrophe
 * — nothing else. Federated names are STRIPPED on ingest; a native edit gets a
 * 400 so the user fixes it at the source. This suite is about the native half.
 *
 * The suite this replaces asserted `expect(mockUser.findById).not.toHaveBeenCalled()`
 * to prove the rejection came "before any DB write". That is a proxy: it says
 * a particular Mongoose call did not happen, not that the column is unchanged —
 * and the call it watched no longer exists. Here the account is seeded with a
 * KNOWN name and re-read after the rejection, so "nothing was written" is
 * checked directly, against the row.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { userService } from '../user.service';
import { DISPLAY_NAME_INVALID_MESSAGE } from '@oxyhq/core';

const uniqueId = () => randomUUID().replace(/-/g, '');

const INVALID_NAME_MESSAGE = DISPLAY_NAME_INVALID_MESSAGE;

/** The name this account starts with; every rejection must leave it intact. */
const SEEDED = { first: 'Original', last: 'Name' } as const;

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({
    id,
    username: `u${id}`,
    nameFirst: SEEDED.first,
    nameLast: SEEDED.last,
  });
  return id;
}

async function storedName(userId: string) {
  const [row] = await getDb()
    .select({ first: users.nameFirst, last: users.nameLast })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('a name outside the policy is refused and nothing is stored', () => {
  it.each([
    ['an emoji', { first: 'nixCraft 🐧' }],
    ['a :shortcode:', { last: 'Laura :bongoCat:' }],
    ['a symbol', { first: 'Dabid ⁂', last: 'OK' }],
    ['a digit', { first: 'Agent007' }],
    ['a hyphen', { first: 'Mary-Jane' }],
    ['a full stop', { last: 'St. Clair' }],
  ])('rejects %s with a 400', async (_label, name) => {
    const id = await makeUser();

    await expect(userService.updateUserProfile(id, { name })).rejects.toMatchObject({
      statusCode: 400,
      message: INVALID_NAME_MESSAGE,
    });
    await expect(userService.updateUserProfile(id, { name })).rejects.toBeInstanceOf(
      BadRequestError
    );

    // The column is untouched. A validator that ran AFTER the write would fail
    // here and pass a rejects-only assertion.
    expect(await storedName(id)).toEqual({ first: SEEDED.first, last: SEEDED.last });
  });

  it('rejects the whole update, not just the offending field', async () => {
    // The policy check runs before any field is applied, so an accompanying
    // legal edit must not land either — otherwise a client sees a half-applied
    // profile with no error to explain it.
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { name: { first: 'Agent007' }, bio: 'sneaks in' })
    ).rejects.toBeInstanceOf(BadRequestError);

    const [row] = await getDb()
      .select({ bio: users.bio, first: users.nameFirst })
      .from(users)
      .where(eq(users.id, id));
    expect(row).toEqual({ bio: null, first: SEEDED.first });
  });
});

describe('a name inside the policy is stored verbatim', () => {
  it.each([
    ['an accented letter', { first: 'Renée', last: 'Étienne' }],
    ['an apostrophe', { first: "N'Golo", last: "O'Brien" }],
    ['a non-Latin script', { first: 'Ольга', last: '中村' }],
  ])('accepts %s', async (_label, name) => {
    const id = await makeUser();

    const updated = await userService.updateUserProfile(id, { name });

    expect(updated.name).toEqual(name);
    expect(await storedName(id)).toEqual({ first: name.first, last: name.last });
  });

  it('stores a decomposed combining mark in precomposed NFC form', async () => {
    // The policy admits combining marks, and the normalizer applies NFC. Both
    // halves matter: a decomposed name must be ACCEPTED (the mark is legal) and
    // stored in ONE canonical form, or the same human name has two spellings in
    // the database and neither search nor uniqueness can see them as equal.
    // Spelled with escapes because the two forms are visually identical.
    const decomposed = 'Ana\u0301'; // 'Ana' + COMBINING ACUTE ACCENT
    const precomposed = 'An\u00e1'; // 'An' + LATIN SMALL LETTER A WITH ACUTE
    expect(decomposed).not.toBe(precomposed);

    const id = await makeUser();
    await userService.updateUserProfile(id, {
      name: { first: decomposed, last: 'Gomez' },
    });

    expect(await storedName(id)).toEqual({ first: precomposed, last: 'Gomez' });
  });

  it('composes `name.displayName` on the DTO from the stored parts', async () => {
    // `name.displayName` is the canonical contract every ecosystem app renders;
    // it is composed server-side and must never be rebuilt by a client.
    const id = await makeUser();

    await userService.updateUserProfile(id, { name: { first: 'Grace', last: 'Hopper' } });
    const view = await userService.getPublicUserById(id);
    const dto = userService.formatUserResponse(view as NonNullable<typeof view>);

    expect(dto.name).toMatchObject({
      first: 'Grace',
      last: 'Hopper',
      full: 'Grace Hopper',
      displayName: 'Grace Hopper',
    });
  });
});
