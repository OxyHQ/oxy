/**
 * The PUBLIC user row contract of the follower / following / mutual lists.
 *
 * These three lists render the same row everywhere in the ecosystem, and the
 * bug this file exists for is that they silently DIDN'T: the follower /
 * following / mutual queries omitted `bio`, `verified` and `federation`, so the
 * API emitted `bio: undefined` on every row while the serializer and the wire
 * contract both carried the field. Nothing errored.
 *
 * The suite this replaces asserted that the Mongoose `.select(...)` argument
 * equalled `PUBLIC_USER_PROFILE_SELECT`. That is the projection STRING, not the
 * emitted row — it could not tell a field that was selected from one that
 * survived to the DTO, and the projection it compared against is now vestigial
 * (`publicUserProjection.ts` keeps it only for the one unported Mongo reader).
 *
 * Here one richly-populated account is put on the far side of each of the three
 * lists and the emitted DTO is compared field by field. The negative half is
 * equally load-bearing: a public row must NOT carry credential material, the
 * contact-discovery hashes, or the owner-only fields.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { userLinkMetadata } from '../../db/schema/userLinkMetadata';
import { users } from '../../db/schema/users';
import type { PublicUserProfile } from '../../types/user.types';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** Fields a public row must never carry, whatever the query selected. */
const FORBIDDEN_ON_A_PUBLIC_ROW = [
  '_id',
  'email',
  'phone',
  'address',
  'birthday',
  'password',
  'refreshToken',
  'hashedEmail',
  'hashedPhone',
  'publicKey',
  'themePreference',
] as const;

async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, ...overrides });
  return id;
}

/**
 * A federated account with EVERY public field populated, plus the private ones
 * that must not leak. `bio`, `verified` and `federation` are the three the
 * lists used to drop.
 */
async function makeRichUser(): Promise<string> {
  const id = await makeUser({
    nameFirst: 'Remote',
    nameLast: 'Friend',
    avatar: 'file-remote-avatar',
    color: 'blue',
    bio: 'Bio that the rows never used to receive.',
    description: 'A longer public description.',
    links: ['https://remote.test/profile'],
    verified: true,
    type: 'federated',
    federationActorUri: `https://mastodon.social/users/${uniqueId()}`,
    federationDomain: 'mastodon.social',
    // Private / owner-only — present in the row so a leak is observable.
    email: `${uniqueId()}@example.test`,
    phone: '+34600000000',
    address: '1 Test Street',
    birthday: '1990-01-01',
    themePreferenceMode: 'dark',
    themePreferenceColorPreset: 'blue',
  });

  await getDb().insert(userLinkMetadata).values({
    userId: id,
    position: 0,
    url: 'https://remote.test/profile',
    title: 'Profile',
    description: 'Remote profile',
    image: null,
  });

  return id;
}

/** Every public field of the rich account, as the wire promises it. */
function expectRichPublicRow(dto: PublicUserProfile, id: string): void {
  expect(dto.id).toBe(id);
  expect(dto.name).toMatchObject({
    first: 'Remote',
    last: 'Friend',
    full: 'Remote Friend',
    displayName: 'Remote Friend',
  });
  expect(dto.avatar).toBe('file-remote-avatar');
  expect(dto.color).toBe('blue');
  // The three the lists silently dropped.
  expect(dto.bio).toBe('Bio that the rows never used to receive.');
  expect(dto.verified).toBe(true);
  expect(dto.federation).toEqual({
    actorUri: expect.stringContaining('https://mastodon.social/users/'),
    domain: 'mastodon.social',
  });

  expect(dto.description).toBe('A longer public description.');
  expect(dto.links).toEqual(['https://remote.test/profile']);
  expect(dto.linksMetadata).toEqual([
    {
      url: 'https://remote.test/profile',
      title: 'Profile',
      description: 'Remote profile',
      image: null,
    },
  ]);
  expect(dto.type).toBe('federated');
  expect(dto.isFederated).toBe(true);
  expect(dto.fediverseSharing).toBe(true);
  expect(dto.createdAt).toBeInstanceOf(Date);
  expect(dto.updatedAt).toBeInstanceOf(Date);

  for (const field of FORBIDDEN_ON_A_PUBLIC_ROW) {
    expect(dto).not.toHaveProperty(field);
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('every follow-graph list emits the full public row', () => {
  it('getUserFollowers', async () => {
    const subject = await makeUser();
    const rich = await makeRichUser();
    await getDb().insert(userFollows).values({ followerId: rich, followedId: subject });

    const page = await userService.getUserFollowers(subject, { limit: 10 });

    expect(page.total).toBe(1);
    expectRichPublicRow(page.data[0], rich);
  });

  it('getUserFollowing', async () => {
    const subject = await makeUser();
    const rich = await makeRichUser();
    await getDb().insert(userFollows).values({ followerId: subject, followedId: rich });

    const page = await userService.getUserFollowing(subject, { limit: 10 });

    expect(page.total).toBe(1);
    expectRichPublicRow(page.data[0], rich);
  });

  it('getUserMutuals', async () => {
    // "Followers you know": the viewer follows the rich account, and the rich
    // account follows the target.
    const viewer = await makeUser();
    const target = await makeUser();
    const rich = await makeRichUser();
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: rich },
        { followerId: rich, followedId: target },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });

    expect(page.total).toBe(1);
    expectRichPublicRow(page.data[0], rich);
  });

  it('getUsersByIds, which additionally carries the measured follow counts', async () => {
    const rich = await makeRichUser();
    const followerA = await makeUser();
    const followerB = await makeUser();
    const followed = await makeUser();
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: followerA, followedId: rich },
        { followerId: followerB, followedId: rich },
        { followerId: rich, followedId: followed },
      ]);

    const [dto] = await userService.getUsersByIds([rich]);

    expectRichPublicRow(dto, rich);
    // The exact arithmetic: the shipped bug returned a well-typed 0 here.
    expect(dto._count).toEqual({ followers: 2, following: 1 });
  });
});

describe('a list row carries no owner-only field even when the account has one', () => {
  it('omits phone, address, birthday and themePreference from a follower row', async () => {
    const subject = await makeUser();
    const rich = await makeRichUser();
    await getDb().insert(userFollows).values({ followerId: rich, followedId: subject });

    const page = await userService.getUserFollowers(subject, { limit: 10 });
    const [row] = page.data;

    // Stated individually as well as through the shared list, so a failure names
    // the field that leaked.
    expect(row).not.toHaveProperty('phone');
    expect(row).not.toHaveProperty('address');
    expect(row).not.toHaveProperty('birthday');
    expect(row).not.toHaveProperty('themePreference');
    expect(row).not.toHaveProperty('email');
  });

  it('still carries them on the OWNER’s own view, so the gate is the caller not the column', async () => {
    const rich = await makeRichUser();

    const self = await userService.getCurrentUser(rich);
    const dto = userService.formatUserResponse(self as NonNullable<typeof self>, undefined, {
      includePrivateFields: true,
    });

    expect(dto.phone).toBe('+34600000000');
    expect(dto.address).toBe('1 Test Street');
    expect(dto.birthday).toBe('1990-01-01');
    expect(dto.themePreference).toEqual({ mode: 'dark', colorPreset: 'blue' });
  });
});

describe('an ineligible counterparty is dropped from the list AND the total', () => {
  it.each([
    ['archived', { accountStatus: 'archived' as const }],
    ['restricted', { reputationTier: 'restricted' as const }],
  ])('excludes a %s follower', async (_label, overrides) => {
    const subject = await makeUser();
    const visible = await makeUser();
    const hidden = await makeUser(overrides);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: visible, followedId: subject },
        { followerId: hidden, followedId: subject },
      ]);

    const page = await userService.getUserFollowers(subject, { limit: 10 });

    // Both halves: a total counted before the filter would read 2 and leave
    // `hasMore` lying even though the page looks right.
    expect(page.total).toBe(1);
    expect(page.data.map((row) => row.id)).toEqual([visible]);
  });
});
