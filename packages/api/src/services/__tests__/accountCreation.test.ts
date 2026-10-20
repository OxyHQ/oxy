/**
 * accountCreation primitives — against a REAL Postgres.
 *
 * What these protect is a property of stored rows and of the unique index: a
 * taken handle is refused by the INDEX (there is no probe), in any case, with the
 * one error every surface maps; a key account carries its identity method; a
 * welcome is written once.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  BOT_USERNAME_INVALID_MESSAGE,
  NUMERIC_USERNAME_MESSAGE,
  USERNAME_INVALID_MESSAGE,
} from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { notifications } from '../../db/schema/notifications';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import {
  UsernameTakenError,
  canonicalUsername,
  createPersonalAccount,
  welcomeNewAccount,
} from '../accountCreation.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const handle = () => `u${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const publicKey = () => `pk${randomUUID().replace(/-/g, '')}`;

function refusal(run: () => unknown): BadRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestError) return error;
    throw error;
  }
  throw new Error('expected a BadRequestError');
}

describe('canonicalUsername', () => {
  it('canonicalises before judging: trims and collapses whitespace, keeps case', () => {
    expect(canonicalUsername('  Alice_1 ', 'personal')).toBe('Alice_1');
  });

  it('composes a decomposed sequence (NFC) so only one form reaches the index', () => {
    // `normalizeInlineText` runs NFC first; whatever the policy then says, the
    // two spellings of one name are judged as the same string.
    const decomposed = 'josé';
    const composed = 'josé';
    const verdict = (value: string) => {
      try {
        return canonicalUsername(value, 'personal');
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(verdict(decomposed)).toBe(verdict(composed));
  });

  it("refuses with the issue's own message and names the field", () => {
    const spaced = refusal(() => canonicalUsername('al ice', 'personal'));
    expect(spaced.message).toBe(USERNAME_INVALID_MESSAGE);
    expect(spaced.details).toEqual({ field: 'username' });

    expect(refusal(() => canonicalUsername('123456', 'personal')).message).toBe(
      NUMERIC_USERNAME_MESSAGE,
    );
  });

  it('holds a bot to the suffix and nobody else', () => {
    expect(refusal(() => canonicalUsername('helper', 'bot')).message).toBe(
      BOT_USERNAME_INVALID_MESSAGE,
    );
    expect(canonicalUsername('helperbot', 'bot')).toBe('helperbot');
    expect(canonicalUsername('helper', 'organization')).toBe('helper');
    // An illegal handle is reported as illegal, not as a bot missing its label.
    expect(refusal(() => canonicalUsername('a.b', 'bot')).message).toBe(USERNAME_INVALID_MESSAGE);
  });
});

describe('createPersonalAccount', () => {
  it('creates an email account with no key and no auth method', async () => {
    const username = canonicalUsername(handle(), 'personal');
    const email = `${handle()}@example.test`;

    const account = await getDb().transaction((tx) =>
      createPersonalAccount(tx, username, { email }),
    );

    const [stored] = await getDb()
      .select({ username: users.username, email: users.email, publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, account.id));
    expect(stored).toEqual({ username, email, publicKey: null });
    expect(
      await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, account.id)),
    ).toHaveLength(0);
  });

  it('writes the identity auth method with a key account, in the same transaction', async () => {
    const username = canonicalUsername(handle(), 'personal');
    const key = publicKey();

    const account = await getDb().transaction((tx) =>
      createPersonalAccount(tx, username, { publicKey: key }),
    );

    expect(account.publicKey).toBe(key);
    const methods = await getDb()
      .select({ type: userAuthMethods.type, methodPublicKey: userAuthMethods.methodPublicKey })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, account.id));
    expect(methods).toEqual([{ type: 'identity', methodPublicKey: key }]);
  });

  it('refuses a taken handle in any case with UsernameTakenError, and writes nothing', async () => {
    const taken = canonicalUsername(handle(), 'personal');
    await getDb().transaction((tx) => createPersonalAccount(tx, taken, { publicKey: publicKey() }));

    const key = publicKey();
    const loser = canonicalUsername(taken.toUpperCase(), 'personal');
    const failure = await getDb()
      .transaction((tx) => createPersonalAccount(tx, loser, { publicKey: key }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsernameTakenError);
    expect(failure).toMatchObject({ statusCode: 409, details: { field: 'username' } });
    expect(
      await getDb().select({ id: users.id }).from(users).where(eq(users.publicKey, key)),
    ).toHaveLength(0);
  });

  it('lets a non-username violation through untouched', async () => {
    const key = publicKey();
    await getDb().transaction((tx) =>
      createPersonalAccount(tx, canonicalUsername(handle(), 'personal'), { publicKey: key }),
    );

    const failure = await getDb()
      .transaction((tx) =>
        createPersonalAccount(tx, canonicalUsername(handle(), 'personal'), { publicKey: key }),
      )
      .catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(UsernameTakenError);
    expect(failure).toBeInstanceOf(Error);
  });
});

describe('welcomeNewAccount', () => {
  it('welcomes once, attributed to the account itself', async () => {
    const account = await getDb().transaction((tx) =>
      createPersonalAccount(tx, canonicalUsername(handle(), 'personal'), {
        publicKey: publicKey(),
      }),
    );

    await welcomeNewAccount(account.id);
    await welcomeNewAccount(account.id);

    const welcomes = await getDb()
      .select({ actorId: notifications.actorId, entityType: notifications.entityType })
      .from(notifications)
      .where(and(eq(notifications.recipientId, account.id), eq(notifications.type, 'welcome')));
    expect(welcomes).toEqual([{ actorId: account.id, entityType: 'profile' }]);
  });

  it('never throws: a failed greeting does not fail a sign-up', async () => {
    // No such account, so the foreign key refuses the row.
    await expect(welcomeNewAccount(randomUUID())).resolves.toBeUndefined();
  });
});
