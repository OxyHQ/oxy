/**
 * The Daily Brief digest against a real PostgreSQL database.
 *
 * Each case pins one boundary a plausible edit would move: the half-open day
 * interval on `received_at`, the Inbox-only scope, the owner predicate, the
 * exact counts beyond the listed rows, and the two bodies that must never
 * reach the prompt — an encrypted one and one carrying an account secret.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import {
  briefFromModel,
  briefLanguage,
  maskDigits,
  DAILY_BRIEF_MAX_MESSAGES,
  dailyBriefUserPrompt,
  getInboxDailyBriefDigest,
} from '../inboxDailyBrief.service';

const START = new Date('2026-09-02T00:00:00.000Z');
const END = new Date('2026-09-03T00:00:00.000Z');
const NOON = new Date('2026-09-02T12:00:00.000Z');

function unique(): string {
  return randomUUID().replace(/-/g, '');
}

async function owner(): Promise<{ userId: string; inboxId: string; archiveId: string }> {
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [inbox, archive] = await getDb()
    .insert(mailboxes)
    .values([
      { userId: user.id, name: 'Inbox', path: 'INBOX', specialUse: '\\Inbox' },
      { userId: user.id, name: 'Archive', path: 'Archive', specialUse: '\\Archive' },
    ])
    .returning({ id: mailboxes.id });
  return { userId: user.id, inboxId: inbox.id, archiveId: archive.id };
}

function messageValue(
  userId: string,
  mailboxId: string,
  receivedAt: Date,
  options: Partial<{
    seen: boolean;
    starred: boolean;
    subject: string;
    text: string;
    encrypted: boolean;
    draft: boolean;
  }> = {},
) {
  return {
    userId,
    mailboxId,
    messageId: `<${unique()}@example.test>`,
    fromName: 'Ana García',
    fromAddress: 'ana@example.test',
    subject: options.subject ?? 'Quarterly numbers',
    text: options.text ?? 'Can you send me the quarterly numbers by Friday?',
    size: 64,
    date: receivedAt,
    receivedAt,
    seen: options.seen ?? true,
    starred: options.starred ?? false,
    encrypted: options.encrypted ?? false,
    draft: options.draft ?? false,
  };
}

beforeAll(connectPostgres);
afterAll(closePostgres);

describe('getInboxDailyBriefDigest', () => {
  it('reads the Inbox for exactly [start, end) and counts beyond the listed rows', async () => {
    const subject = await owner();
    const stranger = await owner();

    await getDb()
      .insert(messages)
      .values(
        Array.from({ length: DAILY_BRIEF_MAX_MESSAGES + 5 }, (_, index) =>
          messageValue(subject.userId, subject.inboxId, new Date(NOON.getTime() + index * 1000), {
            seen: index % 2 !== 0,
            starred: index % 3 === 0,
          }),
        ),
      );
    await getDb()
      .insert(messages)
      .values([
        // The interval is half-open: START is in, END is out.
        messageValue(subject.userId, subject.inboxId, START, { seen: true }),
        messageValue(subject.userId, subject.inboxId, END, { seen: true }),
        // Not news: already archived, a draft, another owner's mail.
        messageValue(subject.userId, subject.archiveId, NOON, { seen: false }),
        messageValue(subject.userId, subject.inboxId, NOON, { seen: false, draft: true }),
        messageValue(stranger.userId, stranger.inboxId, NOON, { seen: false }),
      ]);

    const digest = await getInboxDailyBriefDigest(subject.userId, START, END);

    expect(digest.today).toEqual({ received: 46, unread: 23, starred: 15 });
    expect(digest.messages).toHaveLength(DAILY_BRIEF_MAX_MESSAGES);
    // Newest first: the last bulk row arrived at NOON + 44 s.
    expect(digest.messages[0]?.receivedAt).toEqual(new Date(NOON.getTime() + 44_000));
    expect(digest.messages[0]).toMatchObject({
      fromName: 'Ana García',
      fromAddress: 'ana@example.test',
      subject: 'Quarterly numbers',
      excerpt: 'Can you send me the quarterly numbers by Friday?',
      excerptWithheld: false,
      hasAttachments: false,
    });
    expect(digest.earlierUnread).toEqual({ total: 0, messages: [] });
  });

  it('lists unread mail from before the day, newest first, with its exact total', async () => {
    const subject = await owner();
    await getDb()
      .insert(messages)
      .values([
        messageValue(subject.userId, subject.inboxId, new Date(START.getTime() - 1), {
          seen: false,
          subject: 'Contract to sign',
        }),
        messageValue(subject.userId, subject.inboxId, new Date('2026-08-20T09:00:00.000Z'), {
          seen: false,
          subject: 'Older',
        }),
        // Read earlier mail is not waiting on anyone.
        messageValue(subject.userId, subject.inboxId, new Date('2026-08-30T09:00:00.000Z'), {
          seen: true,
        }),
      ]);

    const digest = await getInboxDailyBriefDigest(subject.userId, START, END);

    expect(digest.today.received).toBe(0);
    expect(digest.earlierUnread.total).toBe(2);
    expect(digest.earlierUnread.messages.map((message) => message.subject)).toEqual([
      'Contract to sign',
      'Older',
    ]);
  });

  it('never excerpts an encrypted body or one carrying an account secret', async () => {
    const subject = await owner();
    const [withAttachment] = await getDb()
      .insert(messages)
      .values([
        messageValue(subject.userId, subject.inboxId, NOON, { text: 'Invoice attached.' }),
        messageValue(subject.userId, subject.inboxId, new Date(NOON.getTime() + 1000), {
          subject: 'Your sign-in code',
          text: '482913 is your verification code.',
        }),
        messageValue(subject.userId, subject.inboxId, new Date(NOON.getTime() + 2000), {
          text: 'ciphertext that is not readable',
          encrypted: true,
        }),
      ])
      .returning({ id: messages.id });
    const attachmentFiles = await getDb()
      .insert(files)
      .values(
        [0, 1].map((ord) => ({
          sha256: unique().padEnd(64, String(ord)),
          size: 10,
          mime: 'application/pdf',
          ext: 'pdf',
          ownerUserId: subject.userId,
          storageKey: `daily-brief-test/${unique()}`,
          originalName: `invoice-${ord}.pdf`,
        })),
      )
      .returning({ id: files.id });
    await getDb()
      .insert(messageAttachments)
      .values(
        attachmentFiles.map((file, ord) => ({
          messageId: withAttachment.id,
          ord,
          fileId: file.id,
          name: `invoice-${ord}.pdf`,
          contentType: 'application/pdf',
          size: 10,
        })),
      );

    const digest = await getInboxDailyBriefDigest(subject.userId, START, END);
    const [encrypted, secret, invoice] = digest.messages;

    expect(encrypted).toMatchObject({ excerpt: '', excerptWithheld: false });
    expect(secret).toMatchObject({
      subject: 'Your sign-in code',
      excerpt: '',
      excerptWithheld: true,
    });
    // Two attachment rows, one message: EXISTS, not a multiplying join.
    expect(invoice).toMatchObject({ excerpt: 'Invoice attached.', hasAttachments: true });
    expect(digest.today.received).toBe(3);

    const prompt = dailyBriefUserPrompt(digest, END);
    expect(prompt).not.toContain('482913');
    expect(prompt).not.toContain('ciphertext');
  });

  it('is empty for an owner without an Inbox', async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ color: 'teal' })
      .returning({ id: users.id });

    await expect(getInboxDailyBriefDigest(user.id, START, END)).resolves.toEqual({
      today: { received: 0, unread: 0, starred: 0 },
      messages: [],
      earlierUnread: { total: 0, messages: [] },
    });
  });
});

describe('briefLanguage', () => {
  it('names the language of a BCP 47 tag and falls back to English', () => {
    expect(briefLanguage('es-ES')).toBe('Spanish');
    expect(briefLanguage('pt')).toBe('Portuguese');
    expect(briefLanguage(undefined)).toBe('English');
  });
});

describe('briefFromModel', () => {
  const message = (id: string) => ({
    id,
    fromName: null,
    fromAddress: `${id}@example.test`,
    subject: id,
    receivedAt: NOON,
    unread: true,
    starred: false,
    answered: false,
    hasAttachments: false,
    card: null,
    excerpt: '',
    excerptWithheld: false,
  });
  const digest = {
    today: { received: 10, unread: 10, starred: 0 },
    messages: Array.from({ length: 10 }, (_, index) => message(`today-${index + 1}`)),
    earlierUnread: { total: 0, messages: [] },
  };

  it('keeps each section within its limit and cuts a long summary at a word', () => {
    const answer = JSON.stringify({
      summary: `${'word '.repeat(120)}end`,
      items: digest.messages.map((_, index) => ({
        ref: `m${index + 1}`,
        section: 'needs_you',
        note: 'x',
      })),
    });

    const brief = briefFromModel(`Sure! ${answer}`, digest);

    expect(brief?.summary.length).toBeLessThanOrEqual(400);
    expect(brief?.summary.endsWith('word…')).toBe(true);
    expect(brief?.items.map((item) => item.messageId)).toEqual([
      'today-1',
      'today-2',
      'today-3',
      'today-4',
      'today-5',
      'today-6',
    ]);
  });

  it('is null for prose, malformed JSON or an empty summary', () => {
    expect(briefFromModel('You have mail.', digest)).toBeNull();
    expect(briefFromModel('{"summary": ', digest)).toBeNull();
    expect(briefFromModel('{"summary": "  ", "items": []}', digest)).toBeNull();
  });
});

describe('maskDigits', () => {
  it('hides codes and card-like numbers, not short numbers', () => {
    expect(maskDigits('Use the code 118512 to sign in')).toBe('Use the code •••• to sign in');
    expect(maskDigits('Card 4242 4242 4242 4242')).toBe('Card ••••');
    expect(maskDigits('Your 3 new messages')).toBe('Your 3 new messages');
  });
});
