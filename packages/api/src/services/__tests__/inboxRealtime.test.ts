/**
 * Inbox realtime fan-out, against a REAL Postgres.
 *
 * This is the suite that replaced `routes/__tests__/emailInbound.socket.test.ts`.
 * The emit used to live in the Cloudflare webhook route, so it was only ever
 * exercised — and only ever RAN — for mail that arrived that way. It now lives
 * in the service layer, and these tests assert the two properties that made the
 * move worth doing:
 *
 *  - the folder and unread count are read from the database, not guessed;
 *  - `id` (the row) and `messageId` (the RFC header) are DIFFERENT fields.
 *    Conflating them is the bug that made every new mail render twice: a client
 *    deduping an optimistic insert on `messageId` compared a row id against a
 *    `<...@oxy.so>` header and never matched.
 *
 * The unread count is the one to watch. It replaced the denormalized
 * `mailboxes.unseen_messages` column, so it is a filtered aggregate that can
 * return 0 for a reason that is not "no unread mail" — a wrong predicate
 * returns 0 just as quietly. It is asserted as an exact NON-ZERO number against
 * rows written in the same test.
 */

const mockGetIO = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: (...args: unknown[]) => mockGetIO(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { buildSnippet, emitEmailChanged, emitEmailNew, resolveFolder } from '../inboxRealtime';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rt${unique().slice(0, 12)}`, color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

async function folder(userId: string, specialUse: string, name: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name, path: `${name}-${unique()}`, specialUse })
    .returning({ id: mailboxes.id });
  return row.id;
}

/** `unread` unseen messages plus one already-read one, so the filter matters. */
async function seedUnread(userId: string, mailboxId: string, unread: number): Promise<void> {
  for (let i = 0; i < unread; i++) {
    await getDb().insert(messages).values({
      userId,
      mailboxId,
      messageId: `<seed-${unique()}@example.com>`,
      fromAddress: 'alice@example.com',
      subject: '',
      size: 10,
      seen: false,
      date: new Date(),
    });
  }
  await getDb().insert(messages).values({
    userId,
    mailboxId,
    messageId: `<seen-${unique()}@example.com>`,
    fromAddress: 'alice@example.com',
    subject: '',
    size: 10,
    seen: true,
    date: new Date(),
  });
}

function captureSocket() {
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  mockGetIO.mockReturnValue({ to });
  return { emit, to };
}

describe('emitEmailNew', () => {
  it('emits email:new and email:unread_count to the recipient user room', async () => {
    const userId = await account();
    const mailboxId = await folder(userId, '\\Inbox', 'INBOX');
    await seedUnread(userId, mailboxId, 7);

    const { emit, to } = captureSocket();
    const rowId = unique();

    await emitEmailNew({
      userId,
      id: rowId,
      messageId: '<abc123@example.com>',
      mailboxId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
      from: { name: 'Alice Sender', address: 'alice@example.com' },
      subject: 'Hello there',
      text: 'This is a plain text body that should become the snippet.',
    });

    expect(to).toHaveBeenCalledWith(`user:${userId}`);

    const payload = emit.mock.calls.find(([event]) => event === 'email:new')?.[1] as Record<string, unknown>;
    expect(payload).toEqual({
      id: rowId,
      messageId: '<abc123@example.com>',
      mailboxId,
      folder: 'inbox',
      from: { name: 'Alice Sender', address: 'alice@example.com' },
      subject: 'Hello there',
      snippet: 'This is a plain text body that should become the snippet.',
      receivedAt: '2024-01-01T00:00:00.000Z',
      unread: true,
    });

    // The two ids are carried separately and are NOT interchangeable.
    expect(payload.id).not.toEqual(payload.messageId);

    const unreadCall = emit.mock.calls.find(([event]) => event === 'email:unread_count');
    // Exact and non-zero: the seven unseen rows, not the eight total, and not
    // the zero a predicate that matched nothing would report.
    expect(unreadCall?.[1]).toEqual({ mailboxId, unread: 7 });
  });

  it('reports the spam folder as its own, not as the inbox', async () => {
    const userId = await account();
    const junkId = await folder(userId, '\\Junk', 'Spam');
    await seedUnread(userId, junkId, 1);

    const { emit } = captureSocket();
    await emitEmailNew({
      userId,
      id: unique(),
      messageId: `<${unique()}@example.com>`,
      mailboxId: junkId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
      from: { address: 'alice@example.com' },
      subject: 'spammy',
      text: 'body',
    });

    const payload = emit.mock.calls.find(([event]) => event === 'email:new')?.[1] as Record<string, unknown>;
    expect(payload.folder).toBe('spam');
  });

  it('omits the sender name rather than sending an empty one', async () => {
    const userId = await account();
    const mailboxId = await folder(userId, '\\Inbox', 'INBOX');
    const { emit } = captureSocket();

    await emitEmailNew({
      userId,
      id: unique(),
      messageId: `<${unique()}@example.com>`,
      mailboxId,
      receivedAt: new Date(),
      from: { name: '', address: 'alice@example.com' },
      subject: 's',
      text: 'b',
    });

    const payload = emit.mock.calls.find(([e]) => e === 'email:new')?.[1] as Record<string, unknown>;
    expect(payload.from).toEqual({ address: 'alice@example.com' });
  });

  it('does not throw when Socket.IO is unavailable (failure isolation)', async () => {
    mockGetIO.mockReturnValue(null);

    await expect(
      emitEmailNew({
        userId: 'whoever',
        id: unique(),
        messageId: '<x@example.com>',
        mailboxId: 'nonexistent',
        receivedAt: new Date(),
        from: { address: 'alice@example.com' },
        subject: 's',
        text: 'b',
      }),
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Socket.IO not initialised'),
    );
  });

  it('does not throw when the database read fails', async () => {
    captureSocket();
    // A mailbox id that is not a valid row: the folder lookup returns nothing
    // and the unread count runs against a mailbox with no messages. Neither is
    // allowed to turn into an exception on the ingest path.
    await expect(
      emitEmailNew({
        userId: await account(),
        id: unique(),
        messageId: '<x@example.com>',
        mailboxId: unique(),
        receivedAt: new Date(),
        from: { address: 'alice@example.com' },
        subject: 's',
        text: 'b',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('emitEmailChanged', () => {
  it('announces both the source and the destination of a move', async () => {
    const userId = await account();
    const from = await folder(userId, '\\Inbox', 'INBOX');
    const dest = await folder(userId, '\\Archive', 'Archive');
    await seedUnread(userId, from, 2);
    await seedUnread(userId, dest, 3);

    const { emit, to } = captureSocket();
    const rowId = unique();
    await emitEmailChanged({ userId, id: rowId, mailboxIds: [from, dest], reason: 'moved' });

    expect(to).toHaveBeenCalledWith(`user:${userId}`);
    const changed = emit.mock.calls.find(([e]) => e === 'email:changed')?.[1];
    expect(changed).toEqual({ id: rowId, mailboxIds: [from, dest], reason: 'moved' });

    // Both mailboxes get a fresh count — a move changes two badges, not one.
    const counts = emit.mock.calls
      .filter(([e]) => e === 'email:unread_count')
      .map(([, payload]) => payload);
    expect(counts).toEqual(
      expect.arrayContaining([
        { mailboxId: from, unread: 2 },
        { mailboxId: dest, unread: 3 },
      ]),
    );
  });

  it('drops null and duplicate mailbox ids', async () => {
    const userId = await account();
    const mailboxId = await folder(userId, '\\Inbox', 'INBOX');
    const { emit } = captureSocket();

    await emitEmailChanged({
      userId,
      id: unique(),
      mailboxIds: [mailboxId, null, undefined, mailboxId],
      reason: 'flags',
    });

    const changed = emit.mock.calls.find(([e]) => e === 'email:changed')?.[1] as { mailboxIds: string[] };
    expect(changed.mailboxIds).toEqual([mailboxId]);
  });
});

describe('buildSnippet', () => {
  it('prefers text, and collapses the line breaks a sender happened to write', () => {
    expect(buildSnippet('one\ntwo\r\nthree', '<p>ignored</p>')).toBe('one two three');
  });

  it('falls back to html with tags, scripts and entities stripped', () => {
    const html = '<style>p{color:red}</style><script>alert(1)</script><p>Hi&nbsp;&amp;&nbsp;bye</p>';
    expect(buildSnippet(undefined, html)).toBe('Hi & bye');
  });

  /**
   * `</script >` is a valid end tag. A pattern matching only `</script>` leaves
   * the script BODY in the preview — which is the sender's text, quoted back at
   * the reader as if it were their message.
   */
  it.each([
    ['</script >', '<script>trackMe()</script >after'],
    ['</script\n>', '<script>trackMe()</script\n>after'],
    ['uppercase', '<SCRIPT>trackMe()</SCRIPT  >after'],
    ['with attributes', '<script type="text/javascript">trackMe()</script>after'],
  ])('strips a script closed with %s', (_label, html) => {
    const snippet = buildSnippet(undefined, html);
    expect(snippet).not.toContain('trackMe');
    expect(snippet).toContain('after');
  });

  /**
   * Chained replaces double-unescape: `&amp;lt;` becomes `&lt;` becomes `<`.
   * The sender writes that string, so it decides what the preview shows.
   */
  it('decodes entities once, so &amp;lt; stays literal', () => {
    expect(buildSnippet(undefined, '<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
  });

  it('leaves an entity it does not know alone', () => {
    expect(buildSnippet(undefined, '<p>caf&eacute;</p>')).toBe('caf&eacute;');
  });

  it('drops comments rather than quoting them', () => {
    expect(buildSnippet(undefined, '<!-- hidden --><p>shown</p>')).toBe('shown');
  });

  it('never exceeds 140 characters', () => {
    expect(buildSnippet('x'.repeat(500)).length).toBe(140);
  });

  it('is empty when there is no body at all', () => {
    expect(buildSnippet(undefined, undefined)).toBe('');
  });
});

describe('resolveFolder', () => {
  it.each([
    ['\\Junk', 'Spam', 'spam'],
    ['\\Inbox', 'INBOX', 'inbox'],
    [null, 'Receipts', 'receipts'],
    [null, '   ', 'inbox'],
    [null, null, 'inbox'],
  ])('special-use %s / name %s -> %s', (specialUse, name, expected) => {
    expect(resolveFolder(specialUse, name)).toBe(expected);
  });
});
