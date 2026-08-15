/**
 * `searchMessages`, against a REAL Postgres.
 *
 * Mongo's `$text` + `{score: {$meta: 'textScore'}}` becomes a `tsvector` match
 * plus an EXPLICIT `ts_rank` weight vector. That explicitness is the point:
 * `ts_rank`'s default `{0.1, 0.2, 0.4, 1.0}` happens to be the 10:1 A-over-D
 * ratio Mongo declared as `weights: {subject: 10, text: 1}`, but a default is a
 * thing that can change underneath a search — and a wrongly-ranked query
 * compiles, runs, and returns the same ROWS in a different ORDER, which no
 * membership assertion can see. So the ordering is asserted, not just the set.
 *
 * The structured filters (`from`/`to`/`subject`) were unanchored
 * case-insensitive regexes over escaped literals. They are `strpos` now, which
 * has no metacharacter language at all — so the port both preserves the
 * semantics and removes the escaping routine that existed to neutralize ReDoS.
 * The 128-character cap stays: that 400 is a documented contract.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: {}, default: {} }));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messageRecipients } from '../../db/schema/messageRecipients';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function folder(userId: string, specialUse = '\\Inbox'): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'INBOX', path: `INBOX-${unique()}`, specialUse })
    .returning({ id: mailboxes.id });
  return row.id;
}

async function store(
  userId: string,
  mailboxId: string,
  values: Partial<typeof messages.$inferInsert> & { to?: string[] } = {},
): Promise<string> {
  const { to, ...columns } = values;
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: 10,
      date: new Date(),
      ...columns,
    })
    .returning({ id: messages.id });

  if (to?.length) {
    await getDb()
      .insert(messageRecipients)
      .values(to.map((address, ord) => ({ messageId: row.id, kind: 'to' as const, ord, address })));
  }
  return row.id;
}

async function attach(userId: string, messageId: string): Promise<void> {
  const [file] = await getDb()
    .insert(files)
    .values({
      sha256: unique(),
      size: 10,
      mime: 'application/pdf',
      ext: 'pdf',
      storageKey: `assets/${unique()}`,
      ownerUserId: userId,
    })
    .returning({ id: files.id });
  await getDb().insert(messageAttachments).values({
    messageId,
    ord: 0,
    fileId: file.id,
    name: 'a.pdf',
    contentType: 'application/pdf',
    size: 10,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('searchMessages — the weighted text index', () => {
  it('ranks a subject hit above a body hit, as Mongo weighted it 10:1', async () => {
    // The assertion that matters is the ORDER. Both rows match either way; a
    // weight vector of B or C — or `ts_rank`'s argument order transposed —
    // returns the same two rows the other way round and nothing else notices.
    const userId = await owner();
    const mailboxId = await folder(userId);
    const term = `zylophant${unique().slice(0, 8)}`;

    const inBody = await store(userId, mailboxId, {
      subject: 'nothing relevant here',
      text: `the word ${term} appears only in the body`,
    });
    const inSubject = await store(userId, mailboxId, {
      subject: `Your ${term} receipt`,
      text: 'nothing relevant in the body at all',
    });

    const { data, total } = await emailService.searchMessages(userId, term);

    expect(total).toBe(2);
    expect(data.map((m) => m.id)).toEqual([inSubject, inBody]);
  });

  it('matches on the body as well as the subject', async () => {
    // A vector built from `subject` alone still passes the ranking test above.
    const userId = await owner();
    const mailboxId = await folder(userId);
    const term = `betaword${unique().slice(0, 8)}`;
    const id = await store(userId, mailboxId, { subject: 'unrelated', text: `only ${term} here` });

    const { data } = await emailService.searchMessages(userId, term);
    expect(data.map((m) => m.id)).toEqual([id]);
  });

  it('stems, as a text index does and a substring match does not', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const id = await store(userId, mailboxId, { subject: 'Invoices attached' });

    const { data } = await emailService.searchMessages(userId, 'invoice');
    expect(data.map((m) => m.id)).toEqual([id]);
  });

  it('never returns another account`s mail', async () => {
    const mine = await owner();
    const theirs = await owner();
    const term = `sharedterm${unique().slice(0, 8)}`;
    await store(theirs, await folder(theirs), { subject: `their ${term}` });
    const mineId = await store(mine, await folder(mine), { subject: `my ${term}` });

    const { data, total } = await emailService.searchMessages(mine, term);
    expect(data.map((m) => m.id)).toEqual([mineId]);
    expect(total).toBe(1);
  });

  it('withholds the bodies it searched', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const term = `secretword${unique().slice(0, 8)}`;
    await store(userId, mailboxId, { subject: term, text: 'SENSITIVE BODY' });

    const { data } = await emailService.searchMessages(userId, term);
    expect(JSON.stringify(data)).not.toContain('SENSITIVE BODY');
    expect(data[0].text).toBeUndefined();
    expect(data[0].headers).toBeUndefined();
  });
});

describe('searchMessages — structured filters', () => {
  it('filters by the PostgreSQL messages.seen column', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const unread = await store(userId, mailboxId, { subject: 'status', seen: false });
    const read = await store(userId, mailboxId, { subject: 'status', seen: true });

    await expect(emailService.searchMessages(userId, 'status', { seen: false })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: unread })],
      total: 1,
    });
    await expect(emailService.searchMessages(userId, 'status', { seen: true })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: read })],
      total: 1,
    });
  });

  it('matches from, to and subject as case-insensitive substrings', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    const wanted = await store(userId, mailboxId, {
      fromAddress: `ops+${tag}@example.com`,
      subject: `Invoice ${tag} final`,
      to: [`billing+${tag}@example.com`],
    });
    await store(userId, mailboxId, { fromAddress: 'someone@example.com', subject: 'unrelated' });

    await expect(
      emailService.searchMessages(userId, '', { from: `OPS+${tag.toUpperCase()}` }),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ id: wanted })] });
    await expect(
      emailService.searchMessages(userId, '', { to: `BILLING+${tag.toUpperCase()}` }),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ id: wanted })] });
    await expect(
      emailService.searchMessages(userId, '', { subject: `invoice ${tag}` }),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ id: wanted })] });
  });

  it('treats regex metacharacters as literal text, matching nothing spurious', async () => {
    // The old query escaped these to neutralize ReDoS. `strpos` has no pattern
    // language, so `(a+)+$` is just eight characters — and it must not match a
    // message that would have matched it as a REGEX.
    const userId = await owner();
    const mailboxId = await folder(userId);
    const literal = await store(userId, mailboxId, { subject: 'total (a+)+$ due' });
    await store(userId, mailboxId, { subject: 'aaaaaaaa' });

    const { data } = await emailService.searchMessages(userId, '', { subject: '(a+)+$' });
    expect(data.map((m) => m.id)).toEqual([literal]);
  });

  it('rejects an overlong filter before it reaches the database', async () => {
    const userId = await owner();
    await expect(
      emailService.searchMessages(userId, '', { from: 'a'.repeat(129) }),
    ).rejects.toThrow('Search filters must be 128 characters or fewer');
    await expect(
      emailService.searchMessages(userId, '', { from: 'a'.repeat(128) }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it('filters on attachments, star, label, mailbox and date range', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const other = await folder(userId, '\\Archive');
    const tag = `tagword${unique().slice(0, 8)}`;

    const withAttachment = await store(userId, mailboxId, { subject: tag });
    await attach(userId, withAttachment);
    const starred = await store(userId, mailboxId, { subject: tag, starred: true });
    const labelled = await store(userId, mailboxId, { subject: tag, labels: ['Work'] });
    const elsewhere = await store(userId, other, { subject: tag });
    const old = await store(userId, mailboxId, {
      subject: tag,
      date: new Date(Date.UTC(2020, 0, 1)),
    });

    await expect(
      emailService.searchMessages(userId, tag, { hasAttachment: true }),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ id: withAttachment })] });
    await expect(emailService.searchMessages(userId, tag, { starred: true })).resolves.toMatchObject(
      { data: [expect.objectContaining({ id: starred })] },
    );
    await expect(emailService.searchMessages(userId, tag, { label: 'Work' })).resolves.toMatchObject(
      { data: [expect.objectContaining({ id: labelled })] },
    );
    await expect(
      emailService.searchMessages(userId, tag, { mailboxId: other }),
    ).resolves.toMatchObject({ data: [expect.objectContaining({ id: elsewhere })] });

    const { data: onlyOld } = await emailService.searchMessages(userId, tag, {
      dateBefore: new Date(Date.UTC(2021, 0, 1)).toISOString(),
    });
    expect(onlyOld.map((m) => m.id)).toEqual([old]);
  });

  it('sorts by date when there is no query, with a stable tiebreak', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const at = Date.UTC(2026, 0, 1);
    const older = await store(userId, mailboxId, {
      subject: 'a',
      fromAddress: `x-${unique()}@example.com`,
      date: new Date(at),
    });
    const newer = await store(userId, mailboxId, {
      subject: 'b',
      fromAddress: `x-${unique()}@example.com`,
      date: new Date(at + 1000),
    });

    const { data } = await emailService.searchMessages(userId, '', { mailboxId });
    expect(data.map((m) => m.id)).toEqual([newer, older]);
  });

  it('paginates against a total that ignores the page', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const term = `pageword${unique().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      await store(userId, mailboxId, { subject: `${term} ${i}` });
    }

    const first = await emailService.searchMessages(userId, term, { limit: 2, offset: 0 });
    const second = await emailService.searchMessages(userId, term, { limit: 2, offset: 2 });

    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    expect(first.data).toHaveLength(2);
    expect(new Set([...first.data, ...second.data].map((m) => m.id)).size).toBe(4);
  });
});
