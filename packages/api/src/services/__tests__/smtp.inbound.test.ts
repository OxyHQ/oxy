/**
 * The inbound-SMTP recipient check, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **`RCPT TO` accepts mail for an account whose stored username differs from
 * the envelope address only by CASE.**
 *
 * The lookup is written `lower(btrim(username)) = lower(btrim($1))` — the
 * EXPRESSION `users_lower_username_key` is built on. A plain `username = $1` is
 * correct-looking, case-sensitive, and does not use that index, which is
 * exactly what the Mongo version did: it compared `{ username }` for equality
 * against an address it had already lower-cased, so mail to `Nate@oxy.so` was
 * rejected at `RCPT TO` for an account stored as `Nate` — while the Cloudflare
 * webhook path (`routes/emailInbound.ts`, already ported) delivered the same
 * message. The two inbound routes now agree, and the case below is what says so.
 *
 * ## Why this tests a function rather than the server
 *
 * `startSmtpInbound` throws unless `SMTP_TLS_KEY` / `SMTP_TLS_CERT` name
 * readable certificates, and the `onRcptTo` handler is a closure inside
 * `new SMTPServer({...})` — unreachable from a test. The lookup the server
 * accepts or rejects mail on is therefore `findRecipientAccountId`, exported and
 * called by that handler, so what runs here is the code path the server runs.
 */

import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EMAIL_DOMAIN } from '../../config/email.config';
import { users } from '../../db/schema/users';
import { findRecipientAccountId } from '../smtp.inbound';

const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
const createdAccounts: string[] = [];

async function insertAccount(username: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
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

describe('findRecipientAccountId', () => {
  it('resolves the account for an address on our domain', async () => {
    const username = `mailbox-${RUN}`;
    const id = await insertAccount(username);

    expect(await findRecipientAccountId(`${username}@${EMAIL_DOMAIN}`)).toBe(id);
  });

  it('accepts mail addressed in a DIFFERENT case than the stored username', async () => {
    // The Mongo lookup rejected this: it compared a lower-cased address against
    // a username stored with capitals. The webhook path accepted it, so the two
    // inbound routes disagreed about whether the mailbox existed.
    const username = `MixedCase-${RUN}`;
    const id = await insertAccount(username);

    expect(await findRecipientAccountId(`${username.toUpperCase()}@${EMAIL_DOMAIN}`)).toBe(id);
    expect(await findRecipientAccountId(`${username.toLowerCase()}@${EMAIL_DOMAIN}`)).toBe(id);
  });

  it('strips the plus-alias before resolving', async () => {
    const username = `alias-${RUN}`;
    const id = await insertAccount(username);

    expect(await findRecipientAccountId(`${username}+shopping@${EMAIL_DOMAIN}`)).toBe(id);
  });

  it('refuses an address on someone else\'s domain', async () => {
    const username = `elsewhere-${RUN}`;
    await insertAccount(username);

    expect(await findRecipientAccountId(`${username}@example.com`)).toBeNull();
  });

  it('refuses an address with no account behind it', async () => {
    expect(await findRecipientAccountId(`nobody-${RUN}@${EMAIL_DOMAIN}`)).toBeNull();
  });

  it('does not match a username as a prefix', async () => {
    await insertAccount(`prefix-${RUN}`);

    expect(await findRecipientAccountId(`prefix-${RUN}x@${EMAIL_DOMAIN}`)).toBeNull();
  });

  it('refuses a malformed address rather than throwing', async () => {
    // No id-shape or address-shape precheck: a value that parses to no username
    // is a rejection, and one that parses to a username nobody holds matches no
    // row — the same outcome by two routes, neither of them an exception.
    expect(await findRecipientAccountId('not-an-address')).toBeNull();
    expect(await findRecipientAccountId('')).toBeNull();
    expect(await findRecipientAccountId(`@${EMAIL_DOMAIN}`)).toBeNull();
  });
});
