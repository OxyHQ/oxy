/**
 * `resolveUserByIdentifier` against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **The lookup matches the EXPRESSION the unique index is built on —
 * `lower(btrim(column))` — for both a username and an email.**
 *
 * That is not cosmetic. `users_lower_username_key` and `users_lower_email_key`
 * are indexes on `lower(btrim(...))`, so a plain `username = $1` is
 * correct-looking, case-sensitive, and does not use them: `Alice` would fail to
 * resolve for an account stored as `alice`, and an invite would 404 for a user
 * who plainly exists. Every case below feeds a DIFFERENTLY-CASED, padded form
 * of a stored identifier, so a lookup written the plain way goes red naming the
 * identifier it failed to find.
 *
 * The suite this replaces mocked `User.findOne` / `User.find` and asserted the
 * FILTER OBJECT (`expect(User.find).toHaveBeenCalledWith({ username: /^Alice$/i })`).
 * That confirms the query was BUILT as expected and nothing about whether it
 * finds anything — it would have passed against a filter naming a column that
 * does not exist.
 *
 * ## The ambiguity branch, and why the guarantee moved
 *
 * Mongo indexed `username` case-SENSITIVELY while every lookup matched
 * case-INSENSITIVELY, so `alice` and `Alice` could coexist and a naive resolve
 * would grant membership to an arbitrary one of them. The function defended
 * itself by fetching two rows and refusing when both matched.
 *
 * Postgres refuses the PAIR instead: `users_lower_username_key` is unique on
 * `lower(btrim(username))`, so the second account cannot be stored at all. The
 * read-side guard is deleted and the write-side one is asserted here — that is
 * the same guarantee, enforced one layer down where nothing can forget it.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { resolveUserByIdentifier } from './resolveUserIdentifier';

const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
const createdAccounts: string[] = [];

async function insertAccount(values: { username?: string; email?: string; publicKey?: string }) {
  const [row] = await getDb()
    .insert(users)
    .values({ ...values, color: 'teal' })
    .returning({ id: users.id });
  createdAccounts.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  if (createdAccounts.length > 0) {
    await getDb().delete(users).where(inArray(users.id, createdAccounts));
  }
  await closePostgres();
});

describe('resolveUserByIdentifier — usernames', () => {
  it('resolves a username through the lower(btrim(...)) index expression', async () => {
    const username = `alice-${RUN}`;
    const id = await insertAccount({ username });

    // Differently cased AND padded: a plain `username = $1` matches neither.
    const resolved = await resolveUserByIdentifier(`  ${username.toUpperCase()}  `);

    expect(resolved).toEqual({ id, username, email: undefined });
  });

  it('returns the ACCOUNT ID, never the public key', async () => {
    // `routes/accounts.ts` reads `.id` off this value and hands it to
    // `accountService.addMember`. It used to be the model's `id` VIRTUAL, which
    // is `publicKey ?? _id` — so for any account that had linked a Commons
    // identity key the invite path passed KEY MATERIAL where an account id
    // belongs, and `account_members.user_id` is a real foreign key now.
    const publicKey = `04${'ab'.repeat(31)}${RUN.slice(0, 2)}`;
    const username = `keyed-${RUN}`;
    const id = await insertAccount({ username, publicKey });

    const resolved = await resolveUserByIdentifier(username);

    expect(resolved?.id).toBe(id);
    expect(resolved?.id).not.toBe(publicKey);
  });

  it('does not match a username as a prefix or a substring', async () => {
    await insertAccount({ username: `alicia-${RUN}` });

    expect(await resolveUserByIdentifier(`alic`)).toBeNull();
    expect(await resolveUserByIdentifier(`alicia-${RUN}x`)).toBeNull();
  });

  it('returns null for an unknown username', async () => {
    expect(await resolveUserByIdentifier(`nobody-${RUN}`)).toBeNull();
  });

  it('returns null for a blank identifier without querying', async () => {
    expect(await resolveUserByIdentifier('   ')).toBeNull();
  });
});

describe('resolveUserByIdentifier — emails', () => {
  it('resolves an email through the lower(btrim(...)) index expression', async () => {
    const email = `bob-${RUN}@example.com`;
    const id = await insertAccount({ username: `bob-${RUN}`, email });

    const resolved = await resolveUserByIdentifier(`  ${email.toUpperCase()}  `);

    expect(resolved).toEqual({ id, username: `bob-${RUN}`, email });
  });

  it('treats an identifier containing @ as an email, never a username', async () => {
    // The account below has an `@` in neither field, so an email lookup finds
    // nothing — which is the point: `@` selects the COLUMN, and a resolver that
    // fell back to the username column would resolve it.
    await insertAccount({ username: `carol-${RUN}` });

    expect(await resolveUserByIdentifier(`carol-${RUN}@example.com`)).toBeNull();
  });

  it('omits an absent optional rather than emitting null', async () => {
    // Drizzle hands back `null` where Mongoose handed `undefined`; the contract
    // is that an absent optional is OMITTED, and the SDK's zod parse rejects a
    // null.
    const id = await insertAccount({ username: `dave-${RUN}` });

    const resolved = await resolveUserByIdentifier(`dave-${RUN}`);

    expect(resolved).toEqual({ id, username: `dave-${RUN}`, email: undefined });
    expect(resolved?.email).toBeUndefined();
  });
});

describe('the ambiguity the read-side guard used to cover', () => {
  it('refuses to STORE two usernames differing only by case', async () => {
    // This is the guarantee that replaced `limit(2)` + "more than one match is
    // ambiguous": in Mongo the pair could exist and the resolver had to fail
    // closed; here `users_lower_username_key` rejects the second write, so a
    // membership grant can never face two look-alike accounts.
    const username = `twin-${RUN}`;
    await insertAccount({ username });

    await expect(
      getDb().insert(users).values({ username: username.toUpperCase(), color: 'teal' })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('refuses to STORE two emails differing only by surrounding space', async () => {
    // `btrim` and not just `lower`: two rows that canonicalize to the same
    // `hashed_email` must not be able to exist as separate accounts.
    const email = `twin-${RUN}@example.com`;
    await insertAccount({ username: `twin-mail-${RUN}`, email });

    await expect(
      getDb()
        .insert(users)
        .values({ username: `twin-mail2-${RUN}`, email: `  ${email}  `, color: 'teal' })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('resolves the surviving account, since only one can exist', async () => {
    const username = `single-${RUN}`;
    const id = await insertAccount({ username });

    expect((await resolveUserByIdentifier(username.toUpperCase()))?.id).toBe(id);
  });
});

describe('a resolved account is a real row', () => {
  it('names an id that exists in users', async () => {
    // The vacuity floor: without it every case above could pass against a
    // resolver that echoed its input back as an id.
    const username = `real-${RUN}`;
    await insertAccount({ username });

    const resolved = await resolveUserByIdentifier(username);
    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, resolved?.id ?? ''));

    expect(rows).toHaveLength(1);
  });
});
