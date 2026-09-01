/**
 * `GET /email/contacts/suggest`, against a REAL Postgres.
 *
 * Mongo built the candidate set with `$concatArrays` of `from`, `to` and `cc`
 * followed by `$unwind` — an operation that only existed because all three
 * lived on one document. `to` and `cc` are a child table now, so the concat IS
 * a union, and the two halves have to be joined back to `messages` to stay
 * scoped to the reading account.
 *
 * That join is a CORRELATED shape, and the failure mode it has in Drizzle is an
 * empty result with no error at all (`db/schema/CONVENTIONS.md`). So the
 * assertions here are not "some suggestions came back": each one names the
 * address it expects from each SOURCE — the `from` header, the `to` header and
 * the `cc` header — because a broken join returns none of them just as quietly
 * as it returns the wrong ones.
 */

const mockAuthUserId = { current: '' };

jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../services/senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../services/aiLabeling.service', () => ({ aiLabelingService: {} }));
jest.mock('../../services/cardExtraction.service', () => ({ cardExtractionService: {} }));
jest.mock('../../services/emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageRecipients } from '../../db/schema/messageRecipients';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../../services/email.service';
import { suggestContacts } from '../email.controller';

const unique = () => randomUUID().replace(/-/g, '');

interface SuggestRequest {
  user: { id: string };
  query: Record<string, string>;
}

/** Call the handler and return what it wrote to the response. */
async function suggest(userId: string, q: string): Promise<Array<{ name: string | null; address: string }>> {
  let captured: Array<{ name: string | null; address: string }> = [];
  const res = {
    json: (payload: { data: Array<{ name: string | null; address: string }> }) => {
      captured = payload.data;
      return res;
    },
  } as unknown as Response;

  const req = { user: { id: userId }, query: { q } } as unknown as SuggestRequest;
  await suggestContacts(req as never, res);
  return captured;
}

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  mockAuthUserId.current = row.id;
  return row.id;
}

async function folder(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'INBOX', path: `INBOX-${unique()}`, specialUse: '\\Inbox' })
    .returning({ id: mailboxes.id });
  return row.id;
}

/** One message with a sender and, optionally, `to` / `cc` addressees. */
async function store(
  userId: string,
  mailboxId: string,
  from: { name?: string; address: string },
  recipients: { to?: Array<{ name?: string; address: string }>; cc?: Array<{ name?: string; address: string }> } = {},
  date = new Date(),
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromName: from.name ?? null,
      fromAddress: from.address,
      subject: '',
      size: 10,
      date,
    })
    .returning({ id: messages.id });

  const rows = (['to', 'cc'] as const).flatMap((kind) =>
    (recipients[kind] ?? []).map((address, ord) => ({
      messageId: row.id,
      kind,
      ord,
      name: address.name ?? null,
      address: address.address,
    })),
  );
  if (rows.length > 0) await getDb().insert(messageRecipients).values(rows);
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('suggestContacts — the union that replaced $concatArrays', () => {
  it('suggests an address seen only in a From header', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    await store(userId, mailboxId, { name: 'Ada Lovelace', address: `ada-${tag}@example.com` });

    const suggestions = await suggest(userId, `ada-${tag}`);

    expect(suggestions).toContainEqual({ name: 'Ada Lovelace', address: `ada-${tag}@example.com` });
  });

  it('suggests an address seen only in a To header', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    await store(
      userId,
      mailboxId,
      { address: 'someone@example.com' },
      { to: [{ name: 'Grace Hopper', address: `grace-${tag}@example.com` }] },
    );

    const suggestions = await suggest(userId, `grace-${tag}`);

    expect(suggestions).toContainEqual({
      name: 'Grace Hopper',
      address: `grace-${tag}@example.com`,
    });
  });

  it('suggests an address seen only in a Cc header', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    await store(
      userId,
      mailboxId,
      { address: 'someone@example.com' },
      { cc: [{ name: 'Alan Turing', address: `alan-${tag}@example.com` }] },
    );

    const suggestions = await suggest(userId, `alan-${tag}`);

    expect(suggestions).toContainEqual({ name: 'Alan Turing', address: `alan-${tag}@example.com` });
  });

  it('matches on the display name as well as the address', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    await store(userId, mailboxId, { name: `Edsger${tag}`, address: 'ew@example.com' });

    const suggestions = await suggest(userId, `edsger${tag}`.toLowerCase());

    expect(suggestions.map((s) => s.address)).toContain('ew@example.com');
  });

  it('collapses one correspondent seen many times into one suggestion', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    const address = `repeat-${tag}@example.com`;
    for (let i = 0; i < 3; i++) {
      await store(userId, mailboxId, { name: 'Repeat Sender', address });
    }

    const suggestions = await suggest(userId, `repeat-${tag}`);

    expect(suggestions.filter((s) => s.address === address)).toHaveLength(1);
  });

  it('ranks the more frequent correspondent first', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    const often = `often-${tag}@example.com`;
    const seldom = `seldom-${tag}@example.com`;
    for (let i = 0; i < 4; i++) await store(userId, mailboxId, { address: often });
    await store(userId, mailboxId, { address: seldom });

    const suggestions = (await suggest(userId, `-${tag}@example.com`)).map((s) => s.address);

    expect(suggestions.indexOf(often)).toBeLessThan(suggestions.indexOf(seldom));
  });

  it('prefers the most recently used spelling of a name', async () => {
    // `$first` after no `$sort` picked whichever document Mongo scanned first.
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    const address = `renamed-${tag}@example.com`;
    const base = Date.UTC(2026, 0, 1);
    await store(userId, mailboxId, { name: 'Old Name', address }, {}, new Date(base));
    await store(userId, mailboxId, { name: 'New Name', address }, {}, new Date(base + 60_000));

    const suggestions = await suggest(userId, `renamed-${tag}`);

    expect(suggestions).toContainEqual({ name: 'New Name', address });
  });

  it('never suggests an address from another account`s mail', async () => {
    const mine = await owner();
    const theirs = await owner();
    const tag = unique().slice(0, 8);
    await store(
      theirs,
      await folder(theirs),
      { address: `theirfrom-${tag}@example.com` },
      { to: [{ address: `theirto-${tag}@example.com` }] },
    );

    const suggestions = await suggest(mine, tag);

    expect(suggestions).toEqual([]);
  });

  it('puts address-book contacts ahead of message history and never repeats one', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const tag = unique().slice(0, 8);
    const shared = `shared-${tag}@example.com`;
    await emailService.createContact(userId, { name: 'Book Entry', email: shared });
    await store(userId, mailboxId, { name: 'History Name', address: shared });
    await store(userId, mailboxId, { address: `history-${tag}@example.com` });

    const suggestions = await suggest(userId, tag);

    expect(suggestions[0]).toEqual({ name: 'Book Entry', address: shared });
    expect(suggestions.filter((s) => s.address === shared)).toHaveLength(1);
    expect(suggestions.map((s) => s.address)).toContain(`history-${tag}@example.com`);
  });

  it('returns nothing for a query shorter than two characters', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    await store(userId, mailboxId, { address: 'a@example.com' });

    expect(await suggest(userId, 'a')).toEqual([]);
    expect(await suggest(userId, '')).toEqual([]);
  });

  it('treats regex metacharacters as literal text', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    await store(userId, mailboxId, { name: 'Aaaa', address: 'aaaa@example.com' });

    // As a REGEX this matches `aaaa@example.com`; as a literal it matches nothing.
    expect(await suggest(userId, '(a+)+')).toEqual([]);
  });
});
