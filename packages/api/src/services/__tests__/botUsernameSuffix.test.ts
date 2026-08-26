/**
 * A bot account's handle ends in `bot`, on every path that stores one — and on
 * no other kind.
 *
 * ## The rule, and where it is enforced
 *
 * `botUsernameSchema` in `@oxyhq/contracts` is the declaration; this asserts the
 * three write paths actually ask it. There are exactly three, because `kind` is
 * set once and never updated (`updateUserProfile`'s `allowedFields` does not
 * list it, and `updateAccount` takes no kind), so a handle is held to its
 * account's kind at creation and at every later rename:
 *
 *   - `createChildAccount` — `POST /accounts`, and the service channel route,
 *   - `updateAccount` — `PATCH /accounts/:id`,
 *   - `updateUserProfile` — `PUT /users/:userId`, which reaches every account.
 *
 * ## What makes this a labelling rule and not a second policy
 *
 * Every assertion below has a paired NEGATIVE one. `users.username` is a single
 * unique index shared by five kinds and ~74k federated rows, so a rule that
 * leaked past `bot` would not fail loudly — it would refuse renames on
 * organizations and projects, and (pointed at the federated path) reject every
 * remote actor there is. The controls are what say it did not: a `project`, an
 * `organization`, a `channel` and a `personal` account each hold and each rename
 * to a handle that carries no label, in the same suite, against the same
 * database.
 *
 * ## The six accounts this does NOT touch
 *
 * Six bot accounts existed when this was written, and not one is labelled
 * (measured against production 2026-08-26: `community-guide`,
 * `community-maestro`, `community-pulse`, `garden-helper`, `luna`, `verity`).
 * This is a WRITE-path rule; they go on loading and resolving untouched, which
 * `an existing unlabelled bot is not broken by the rule` pins deliberately.
 * Renaming a live handle breaks every link to it and is not a decision a
 * validator gets to make.
 */

import { eq } from 'drizzle-orm';
import {
  usernameSchema,
  usernameSchemaForAccountKind,
  BOT_USERNAME_INVALID_MESSAGE,
  USERNAME_INVALID_MESSAGE,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountService } from '../account.service';
import { userService } from '../user.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

let counter = 0;

/** The whole run shares one database, so every test mints its own names. */
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}z${Date.now().toString(36)}`;
}

/** A handle that carries the label, unique to one test. */
function uniqueBot(prefix: string): string {
  return `${unique(prefix)}bot`;
}

async function seedOwner(): Promise<string> {
  const [owner] = await getDb()
    .insert(users)
    .values({ color: 'teal', kind: 'personal', username: unique('owner') })
    .returning({ id: users.id });
  return owner.id;
}

async function storedUsername(accountId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  return row?.username ?? null;
}

describe('creating a bot account', () => {
  it('refuses a handle that does not end in bot, and says why', async () => {
    const ownerId = await seedOwner();
    const username = unique('gardenhelper');

    await expect(
      accountService.createChildAccount(ownerId, ownerId, { kind: 'bot', username })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: BOT_USERNAME_INVALID_MESSAGE,
    });
  });

  /**
   * The positive control for the refusal above. A 400 thrown AFTER the insert
   * would satisfy `rejects` while leaving the account behind, which is the
   * failure mode a validator placed one line too late produces.
   */
  it('and writes no row when it refuses', async () => {
    const ownerId = await seedOwner();
    const username = unique('gardenhelper');

    await expect(
      accountService.createChildAccount(ownerId, ownerId, { kind: 'bot', username })
    ).rejects.toMatchObject({ statusCode: 400 });

    const [found] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    expect(found).toBeUndefined();
  });

  it('accepts a handle that carries the label', async () => {
    const ownerId = await seedOwner();
    const username = uniqueBot('gardenhelper');

    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username,
    });

    expect(await storedUsername(account.id)).toBe(username);
  });

  /**
   * Case is preserved but uniqueness folds it, so the suffix test must fold it
   * too. This is the discriminator for a bare `endsWith`: it accepts the
   * lower-case handle above and refuses this one, two names the unique index
   * cannot tell apart.
   */
  it('accepts a handle whose label is capitalised, and stores it as typed', async () => {
    const ownerId = await seedOwner();
    const username = `${unique('Garden')}Bot`;

    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username,
    });

    expect(await storedUsername(account.id)).toBe(username);
  });

  /**
   * The suffix is the LAST check. A caller told to append `bot` to a handle the
   * base policy already refuses would append it and be refused again, so the
   * message has to name the thing that is actually wrong.
   */
  it('reports the base policy, not the label, when both are broken', async () => {
    const ownerId = await seedOwner();

    await expect(
      accountService.createChildAccount(ownerId, ownerId, { kind: 'bot', username: 'a.b' })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: USERNAME_INVALID_MESSAGE,
    });
  });
});

describe('and the rule reaches no other kind', () => {
  it.each(['project', 'organization', 'channel'] as const)(
    'a %s account is created under a handle that carries no label',
    async (kind) => {
      const ownerId = await seedOwner();
      const username = unique('communityguide');

      const { account } = await accountService.createChildAccount(ownerId, ownerId, {
        kind,
        username,
      });

      expect(await storedUsername(account.id)).toBe(username);
    }
  );

  it('a personal account signs up under a handle that carries no label', async () => {
    // The signup paths insert with the column default, which is `personal`; this
    // is the shape they produce.
    const [person] = await getDb()
      .insert(users)
      .values({ username: unique('nate'), color: 'teal' })
      .returning({ id: users.id, kind: users.kind });

    expect(person.kind).toBe('personal');
    expect(await storedUsername(person.id)).not.toMatch(/bot$/);
  });

  it('and the label is not RESERVED — an ordinary word ending in it stays free', async () => {
    const ownerId = await seedOwner();
    const username = unique('abbot');

    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'project',
      username,
    });

    expect(await storedUsername(account.id)).toBe(username);
  });
});

describe('renaming through PATCH /accounts/:id', () => {
  it('refuses to take the label off a bot', async () => {
    const ownerId = await seedOwner();
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username: uniqueBot('garden'),
    });
    const before = await storedUsername(account.id);

    await expect(
      accountService.updateAccount(account.id, { username: unique('garden') })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: BOT_USERNAME_INVALID_MESSAGE,
    });

    expect(await storedUsername(account.id)).toBe(before);
  });

  it('allows a bot to move to another labelled handle', async () => {
    const ownerId = await seedOwner();
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username: uniqueBot('garden'),
    });
    const next = uniqueBot('orchard');

    await accountService.updateAccount(account.id, { username: next });

    expect(await storedUsername(account.id)).toBe(next);
  });

  /**
   * The control. The kind comes from the STORED row, so a rule read off the
   * wrong column would show up here as an organization refused a perfectly
   * ordinary handle.
   */
  it.each(['project', 'organization', 'channel'] as const)(
    'lets a %s account rename to a handle that carries no label',
    async (kind) => {
      const ownerId = await seedOwner();
      const { account } = await accountService.createChildAccount(ownerId, ownerId, {
        kind,
        username: unique('before'),
      });
      const next = unique('after');

      await accountService.updateAccount(account.id, { username: next });

      expect(await storedUsername(account.id)).toBe(next);
    }
  );
});

describe('renaming through PUT /users/:userId', () => {
  it('refuses to take the label off a bot', async () => {
    const ownerId = await seedOwner();
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username: uniqueBot('garden'),
    });
    const before = await storedUsername(account.id);

    await expect(
      userService.updateUserProfile(account.id, { username: unique('garden') })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: BOT_USERNAME_INVALID_MESSAGE,
    });

    expect(await storedUsername(account.id)).toBe(before);
  });

  it('lets a bot move to another labelled handle', async () => {
    const ownerId = await seedOwner();
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'bot',
      username: uniqueBot('garden'),
    });
    const next = uniqueBot('orchard');

    await userService.updateUserProfile(account.id, { username: next });

    expect(await storedUsername(account.id)).toBe(next);
  });

  it('lets a personal account rename to a handle that carries no label', async () => {
    const [person] = await getDb()
      .insert(users)
      .values({ username: unique('nate'), color: 'teal' })
      .returning({ id: users.id });
    const next = unique('nathan');

    await userService.updateUserProfile(person.id, { username: next });

    expect(await storedUsername(person.id)).toBe(next);
  });

  /**
   * The write-not-read rule, in the one place it actually bites: the six live
   * bots hold unlabelled handles, and every profile edit a client makes PUTs the
   * whole object back, username included. Validating that echo would make a bio
   * edit fail on an account that has done nothing wrong.
   */
  it('an existing unlabelled bot is not broken by the rule', async () => {
    const ownerId = await seedOwner();
    // The shape production holds — written directly, because the rule now
    // prevents `createChildAccount` from producing it.
    const legacyUsername = unique('communityguide');
    const [bot] = await getDb()
      .insert(users)
      .values({ username: legacyUsername, kind: 'bot', color: 'teal', parentAccountId: ownerId })
      .returning({ id: users.id });

    const updated = await userService.updateUserProfile(bot.id, {
      bio: 'A guide to the community.',
      username: legacyUsername,
    });

    expect(updated.bio).toBe('A guide to the community.');
    expect(await storedUsername(bot.id)).toBe(legacyUsername);
  });
});

/**
 * The other namespace in the same column, asserted here rather than left to a
 * comment: ~74k rows are remote actors stored as `handle@domain`, written by
 * `PUT /users/resolve` through its own normalizer. `usersResolve.test.ts` proves
 * the ROUTE still stores one; this proves neither schema could have governed it
 * if it had been pointed there.
 */
describe('and it says nothing about the federated namespace', () => {
  it('a remote bot actor fails BOTH schemas, so neither may be applied to that path', () => {
    const remote = 'newsbot@mastodon.social';

    expect(usernameSchema.safeParse(remote).success).toBe(false);
    expect(usernameSchemaForAccountKind('bot').safeParse(remote).success).toBe(false);
  });

  it('and a federated row is stored under exactly that shape, with no kind of its own', async () => {
    const handle = `${unique('news')}@mastodon.social`;
    const [row] = await getDb()
      .insert(users)
      .values({
        username: handle,
        type: 'federated',
        federationActorUri: `https://mastodon.social/users/${unique('news')}`,
        federationDomain: 'mastodon.social',
      })
      .returning({ id: users.id, kind: users.kind, username: users.username });

    // `kind` is never written by the resolve path, so a remote actor is
    // `personal` by column default — the bot rule cannot reach it even in
    // principle.
    expect(row.kind).toBe('personal');
    expect(row.username).toBe(handle);
  });
});
