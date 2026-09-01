/**
 * Managed/org (keyless, `publicKey`-less) account identity on the wire.
 *
 * Regression for the `PUT /users/me` 500 ("User must have a publicKey or _id")
 * when editing a managed/org account while switched (`X-Acting-As`), and for its
 * mirror image: once a self-custody user LINKS a Commons identity and gains a
 * `publicKey`, the DTO `id` must not flip to that key. The whole social graph
 * (Mention `Post.oxyUserId`, follow edges, client follow-state maps) is keyed on
 * the stable account id, so a key-shaped `id` makes a user's posts vanish.
 *
 * The suite this replaces built its inputs by hand — `new Types.ObjectId()`,
 * a `toObject` stub returning `{ id }`, a fake document with `set`/`save` — so
 * it asserted that the serializer tolerates shapes the test itself invented.
 * Those shapes came from the Mongoose transform, which no longer exists. Here
 * the accounts are real rows and the views come from the production readers
 * (`getPublicUserById`, `getCurrentUser`, `updateUserProfile`), so what is
 * checked is that the REAL producers hand the serializer something it can
 * identify.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, ...overrides });
  return id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('a keyless (publicKey-less) account', () => {
  it('serializes with the stable account id from every production reader', async () => {
    const id = await makeUser({ nameFirst: 'Acme', nameLast: 'Org' });

    const publicView = await userService.getPublicUserById(id);
    const selfView = await userService.getCurrentUser(id);
    expect(publicView).not.toBeNull();
    expect(selfView).not.toBeNull();

    for (const view of [publicView, selfView]) {
      const dto = userService.formatUserResponse(view as NonNullable<typeof view>);
      expect(dto.id).toBe(id);
      expect(dto.username).toBe(`u${id}`);
    }
  });

  it('survives a profile write — the returned view is still identifiable', async () => {
    // The 500 this replaces happened on the RETURN leg: the write succeeded and
    // then the serializer could not name the account. Serializing the actual
    // return value is the only thing that checks that leg.
    const id = await makeUser();

    const updated = await userService.updateUserProfile(id, {
      name: { first: 'Acme', last: 'Org' },
    });

    expect(() => userService.formatUserResponse(updated)).not.toThrow();
    expect(userService.formatUserResponse(updated).id).toBe(id);
  });

  it('never emits a `publicKey` property it does not have', async () => {
    const id = await makeUser();
    const view = await userService.getPublicUserById(id);
    const dto = userService.formatUserResponse(view as NonNullable<typeof view>);

    expect(dto).not.toHaveProperty('publicKey');
  });
});

describe('a key-anchored account', () => {
  it('keeps `id` as the account id, NOT the publicKey', async () => {
    const publicKey = `04${uniqueId()}${uniqueId()}`;
    const id = await makeUser({ publicKey, nameFirst: 'Nate' });

    const view = await userService.getPublicUserById(id);
    const dto = userService.formatUserResponse(view as NonNullable<typeof view>);

    expect(dto.id).toBe(id);
    expect(dto.id).not.toBe(publicKey);
  });

  it('resolves the same id on the owner’s own view', async () => {
    const publicKey = `04${uniqueId()}${uniqueId()}`;
    const id = await makeUser({ publicKey });

    const self = await userService.getCurrentUser(id);
    const dto = userService.formatUserResponse(self as NonNullable<typeof self>, undefined, {
      includePrivateFields: true,
    });

    expect(dto.id).toBe(id);
  });

  it('is still addressable by the graph after a profile write', async () => {
    // The concrete symptom of the id flip: follow edges are keyed on the account
    // id, so a DTO carrying the key would not match any of them.
    const publicKey = `04${uniqueId()}${uniqueId()}`;
    const id = await makeUser({ publicKey });
    const follower = await makeUser();
    await userService.followUser(follower, id);

    const updated = await userService.updateUserProfile(id, { bio: 'linked identity' });
    const dto = userService.formatUserResponse(updated);

    const statuses = await userService.getFollowingStatuses(follower, [dto.id]);
    expect(statuses).toEqual({ [id]: true });
  });
});

describe('the serializer refuses a source it cannot identify', () => {
  it('throws rather than emitting a DTO with no id', () => {
    // Failing loudly is the contract: a DTO with `id: undefined` would be
    // accepted by every consumer and silently detach the row from the graph.
    expect(() => userService.formatUserResponse({ username: 'nobody' })).toThrow(
      'User must have an _id'
    );
  });
});
