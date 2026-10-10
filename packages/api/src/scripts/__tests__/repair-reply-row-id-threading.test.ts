/** The row-id reply repair, on a REAL Postgres. */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { repairReplyRowIdThreading } from '../repair-reply-row-id-threading';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function fixture() {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ username: `repair${unique().slice(0, 10)}`, color: 'teal' })
    .returning();
  const [mailbox] = await db
    .insert(mailboxes)
    .values({ userId: user.id, name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' })
    .returning();
  const insert = async (values: Partial<typeof messages.$inferInsert>) => {
    const [row] = await db
      .insert(messages)
      .values({
        userId: user.id,
        mailboxId: mailbox.id,
        messageId: `<m-${unique()}@example.com>`,
        fromAddress: 'a@example.com',
        subject: 's',
        size: 1,
        date: new Date(),
        ...values,
      })
      .returning();
    return row;
  };

  const parent = await insert({
    references: ['<root@example.com>'],
    inReplyTo: '<root@example.com>',
  });
  const sentReply = await insert({ inReplyTo: parent.id });
  const deliveredCopy = await insert({
    inReplyTo: `<${parent.id}>`,
    references: [`<${parent.id}>`, '<kept@example.com>'],
  });
  const orphan = await insert({ inReplyTo: randomUUID() });
  return { parent, sentReply, deliveredCopy, orphan };
}

const read = async (id: string) =>
  (
    await getDb()
      .select({ inReplyTo: messages.inReplyTo, references: messages.references })
      .from(messages)
      .where(eq(messages.id, id))
  )[0];

describe('repairReplyRowIdThreading', () => {
  it('reports without writing in a dry run', async () => {
    const { sentReply, parent } = await fixture();
    const stats = await repairReplyRowIdThreading({ apply: false });
    expect(stats.repaired).toBeGreaterThanOrEqual(2);
    expect((await read(sentReply.id)).inReplyTo).toBe(parent.id);
  });

  it('points bare and bracketed row ids at the parent Message-ID and rebuilds References', async () => {
    const { parent, sentReply, deliveredCopy, orphan } = await fixture();
    await repairReplyRowIdThreading({ apply: true });

    expect(await read(sentReply.id)).toEqual({
      inReplyTo: parent.messageId,
      references: ['<root@example.com>', parent.messageId],
    });
    expect(await read(deliveredCopy.id)).toEqual({
      inReplyTo: parent.messageId,
      references: ['<root@example.com>', parent.messageId, '<kept@example.com>'],
    });
    // Nothing to resolve it against: left as it is, and counted.
    expect((await read(orphan.id)).inReplyTo).toBe(orphan.inReplyTo);

    const again = await repairReplyRowIdThreading({ apply: true });
    expect(again.repaired).toBe(0);
  });
});
