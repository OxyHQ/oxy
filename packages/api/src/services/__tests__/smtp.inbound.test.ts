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
 * correct-looking, case-sensitive, and does not use that index — comparing it
 * against an already lower-cased address would reject mail to `Nate@oxy.so` at
 * `RCPT TO` for an account stored as `Nate`, while the Cloudflare webhook path
 * (`routes/emailInbound.ts`) delivers the same message. The two inbound routes
 * agree, and the case below is what says so.
 *
 * ## The reply codes
 *
 * `smtp-server` answers with `err.responseCode` and its own default when that
 * is absent (550 at `RCPT TO`, 450 at `DATA`). A code written into the message
 * is only text after the default, so a spam refusal went out as `450 550 …` and
 * the sender retried it. The handler cases below pin the code each outcome
 * carries, and that no message still starts with one.
 *
 * ## Why this tests functions rather than the server
 *
 * `startSmtpInbound` throws unless `SMTP_TLS_KEY` / `SMTP_TLS_CERT` name
 * readable certificates. `handleRcptTo` and `handleData` are the exact
 * functions the server is configured with, so what runs here is the code path
 * the server runs.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { inArray } from 'drizzle-orm';
import type { SMTPServerDataStream, SMTPServerSession } from 'smtp-server';

import * as postgres from '../../config/postgres';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EMAIL_DOMAIN } from '../../config/email.config';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { findRecipientAccountId, handleData, handleRcptTo } from '../smtp.inbound';
import { spamService } from '../spam.service';

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
    // A case-sensitive lookup would reject this: a lower-cased address against a
    // username stored with capitals. The webhook path accepts it, so the two
    // inbound routes must agree that the mailbox exists.
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

  it("refuses an address on someone else's domain", async () => {
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

type SmtpCallbackError = (Error & { responseCode?: number }) | null | undefined;

/** Run a handler to its callback and return what it was called with. */
function answer(
  run: (callback: (err?: Error | null) => void) => Promise<void>,
): Promise<SmtpCallbackError> {
  return new Promise((resolve, reject) => {
    run((err) => resolve(err)).catch(reject);
  });
}

function session(rcpt: string): SMTPServerSession {
  return {
    envelope: {
      mailFrom: { address: 'alice@example.com', args: false },
      rcptTo: [{ address: rcpt, args: false }],
    },
  } as unknown as SMTPServerSession;
}

/** A DATA stream as `smtp-server` hands it over: bytes, and a size flag it flips mid-transfer. */
function dataStream(chunks: Buffer[], exceedAfter = Number.POSITIVE_INFINITY) {
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= chunks.length) {
        this.push(null);
        return;
      }
      if (sent >= exceedAfter) (stream as unknown as SMTPServerDataStream).sizeExceeded = true;
      this.push(chunks[sent]);
      sent += 1;
    },
  });
  return Object.assign(stream, {
    sizeExceeded: false,
    byteLength: 0,
  }) as unknown as SMTPServerDataStream & Readable;
}

const MESSAGE = Buffer.from(
  [
    'From: Alice <alice@example.com>',
    `To: someone@${EMAIL_DOMAIN}`,
    'Subject: Hi',
    'Message-ID: <smtp-test@example.com>',
    '',
    'Hello',
    '',
  ].join('\r\n'),
);

describe('handleRcptTo', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts an address with an account behind it', async () => {
    const username = `rcpt-${RUN}`;
    await insertAccount(username);

    const err = await answer((cb) =>
      handleRcptTo({ address: `${username}@${EMAIL_DOMAIN}`, args: false }, session(''), cb),
    );

    expect(err).toBeUndefined();
  });

  it('refuses an unknown address with a permanent 550', async () => {
    const err = await answer((cb) =>
      handleRcptTo({ address: `nobody-${RUN}@${EMAIL_DOMAIN}`, args: false }, session(''), cb),
    );

    expect(err?.responseCode).toBe(550);
    expect(err?.message).not.toMatch(/^\d/);
  });

  it('refuses another domain with a permanent 550', async () => {
    const err = await answer((cb) =>
      handleRcptTo({ address: 'someone@example.com', args: false }, session(''), cb),
    );

    expect(err?.responseCode).toBe(550);
    expect(err?.message).not.toMatch(/^\d/);
  });

  it('answers a lookup that threw with a temporary 451, so the sender retries', async () => {
    jest.spyOn(postgres, 'getDb').mockImplementationOnce(() => {
      throw new Error('connection terminated unexpectedly');
    });

    const err = await answer((cb) =>
      handleRcptTo({ address: `anyone-${RUN}@${EMAIL_DOMAIN}`, args: false }, session(''), cb),
    );

    expect(err?.responseCode).toBe(451);
    expect(err?.message).not.toMatch(/^\d/);
  });
});

describe('handleData', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores the message for each recipient and accepts it', async () => {
    jest.spyOn(spamService, 'check').mockResolvedValue({
      score: 0,
      action: 'no action',
      isSpam: false,
    });
    const store = jest.spyOn(emailService, 'storeIncomingMessage').mockResolvedValue({} as never);

    const err = await answer((cb) =>
      handleData(dataStream([MESSAGE]), session(`bob-${RUN}@${EMAIL_DOMAIN}`), cb),
    );

    expect(err).toBeUndefined();
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toMatchObject({
      recipientUsername: `bob-${RUN}`,
      subject: 'Hi',
      messageId: '<smtp-test@example.com>',
      rawSize: MESSAGE.length,
    });
  });

  it('refuses spam with a permanent 550, not the 450 the library defaults to', async () => {
    jest.spyOn(spamService, 'check').mockResolvedValue({
      score: 50,
      action: 'reject',
      isSpam: true,
    });
    jest.spyOn(spamService, 'shouldReject').mockReturnValue(true);
    const store = jest.spyOn(emailService, 'storeIncomingMessage');

    const err = await answer((cb) =>
      handleData(dataStream([MESSAGE]), session(`bob-${RUN}@${EMAIL_DOMAIN}`), cb),
    );

    expect(err?.responseCode).toBe(550);
    expect(err?.message).not.toMatch(/^\d/);
    expect(store).not.toHaveBeenCalled();
  });

  it('answers a failed store with a temporary 451', async () => {
    jest.spyOn(spamService, 'check').mockResolvedValue({
      score: 0,
      action: 'no action',
      isSpam: false,
    });
    jest
      .spyOn(emailService, 'storeIncomingMessage')
      .mockRejectedValue(new Error('connection terminated unexpectedly'));

    const err = await answer((cb) =>
      handleData(dataStream([MESSAGE]), session(`bob-${RUN}@${EMAIL_DOMAIN}`), cb),
    );

    expect(err?.responseCode).toBe(451);
    expect(err?.message).not.toMatch(/^\d/);
  });

  it('drains an oversized message and refuses it with 552, storing nothing', async () => {
    const check = jest.spyOn(spamService, 'check');
    const store = jest.spyOn(emailService, 'storeIncomingMessage');
    const stream = dataStream([MESSAGE, Buffer.alloc(1024), Buffer.alloc(1024)], 1);

    const err = await answer((cb) => handleData(stream, session(`bob-${RUN}@${EMAIL_DOMAIN}`), cb));

    expect(err?.responseCode).toBe(552);
    expect(err?.message).not.toMatch(/^\d/);
    // Read to the end: the connection's next command follows the DATA bytes.
    expect(stream.readableEnded).toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});
