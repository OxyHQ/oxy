/**
 * Daily Brief counts against a real PostgreSQL database.
 *
 * The 106-row case is the positive mutation control for the retired
 * `listMessages({ limit: 100 })` implementation. Exact half-open bounds,
 * account scoping and a two-row attachment fan-out are all asserted together:
 * changing either comparator, dropping the owner predicate, or replacing the
 * correlated EXISTS with a multiplying join changes a named count.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { getInboxDailyBriefCounts } from '../inboxDailyBrief.service';

const START = new Date('2026-09-02T00:00:00.000Z');
const END = new Date('2026-09-03T00:00:00.000Z');

function unique(): string {
  return randomUUID().replace(/-/g, '');
}

async function owner(): Promise<{ userId: string; mailboxId: string }> {
  const [user] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId: user.id, name: 'Inbox', path: `Inbox-${unique()}` })
    .returning({ id: mailboxes.id });
  return { userId: user.id, mailboxId: mailbox.id };
}

function messageValue(
  userId: string,
  mailboxId: string,
  date: Date,
  options: { seen?: boolean; starred?: boolean } = {},
) {
  return {
    userId,
    mailboxId,
    messageId: `<${unique()}@example.test>`,
    fromAddress: 'sender@example.test',
    subject: 'must never enter the Daily Brief query',
    text: 'private body that the aggregate must never select',
    size: 64,
    date,
    seen: options.seen ?? true,
    starred: options.starred ?? false,
  };
}

beforeAll(connectPostgres);
afterAll(closePostgres);

describe('getInboxDailyBriefCounts', () => {
  it('counts the complete half-open interval without row or attachment sampling', async () => {
    const subject = await owner();
    const stranger = await owner();

    const bulk = Array.from({ length: 105 }, (_, index) => messageValue(
      subject.userId,
      subject.mailboxId,
      new Date('2026-09-02T12:00:00.000Z'),
      { seen: index % 2 !== 0, starred: index % 3 === 0 },
    ));
    await getDb().insert(messages).values(bulk);

    const [atStart] = await getDb()
      .insert(messages)
      .values(messageValue(subject.userId, subject.mailboxId, START, {
        seen: false,
        starred: true,
      }))
      .returning({ id: messages.id });

    await getDb().insert(messages).values([
      // Both of these must stay outside [START, END).
      messageValue(subject.userId, subject.mailboxId, new Date(START.getTime() - 1), {
        seen: false,
        starred: true,
      }),
      messageValue(subject.userId, subject.mailboxId, END, {
        seen: false,
        starred: true,
      }),
      // Same interval, different owner: catches a missing user_id predicate.
      messageValue(stranger.userId, stranger.mailboxId, new Date('2026-09-02T12:00:00.000Z'), {
        seen: false,
        starred: true,
      }),
    ]);

    const attachmentFiles = await getDb()
      .insert(files)
      .values([0, 1].map((ord) => ({
        sha256: unique().padEnd(64, String(ord)),
        size: 10,
        mime: 'application/octet-stream',
        ext: 'bin',
        ownerUserId: subject.userId,
        storageKey: `daily-brief-test/${unique()}`,
        originalName: `attachment-${ord}.bin`,
      })))
      .returning({ id: files.id });
    await getDb().insert(messageAttachments).values(attachmentFiles.map((file, ord) => ({
      messageId: atStart.id,
      ord,
      fileId: file.id,
      name: `attachment-${ord}.bin`,
      contentType: 'application/octet-stream',
      size: 10,
    })));

    await expect(getInboxDailyBriefCounts(subject.userId, START, END)).resolves.toEqual({
      total: 106,
      unread: 54,
      starred: 36,
      withAttachments: 1,
    });
  });

  it('returns explicit zeroes for an empty interval', async () => {
    const subject = await owner();

    await expect(getInboxDailyBriefCounts(subject.userId, START, END)).resolves.toEqual({
      total: 0,
      unread: 0,
      starred: 0,
      withAttachments: 0,
    });
  });
});
