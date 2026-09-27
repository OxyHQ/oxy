/**
 * The alternative-body cleanup, on a REAL Postgres. The asset service is
 * stubbed (it owns S3); what rows survive is the guarantee.
 */

const mockUnlinkFile = jest.fn();

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { unlinkFile: (...args: unknown[]) => mockUnlinkFile(...args) },
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { purgeAlternativeBodyAttachments } from '../purge-alternative-body-attachments';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function fixture() {
  const db = getDb();
  const [user] = await db.insert(users).values({ username: `purge${unique().slice(0, 10)}`, color: 'teal' }).returning();
  const [mailbox] = await db
    .insert(mailboxes)
    .values({ userId: user.id, name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({
      userId: user.id,
      mailboxId: mailbox.id,
      messageId: `<m-${unique()}@ramp.com>`,
      fromAddress: 'communications@ramp.com',
      subject: 'code',
      size: 1000 + 300 + 50,
      date: new Date(),
    })
    .returning();

  const file = async (name: string, mime: string, size: number) => {
    const [row] = await db
      .insert(files)
      .values({ sha256: unique(), size, mime, ext: 'bin', storageKey: `assets/${unique()}`, originalName: name, ownerUserId: user.id })
      .returning();
    return row;
  };
  const amp = await file('attachment', 'text/x-amp-html', 300);
  const named = await file('email.amp.html', 'text/x-amp-html', 50);

  await db.insert(messageAttachments).values([
    { messageId: message.id, ord: 0, fileId: amp.id, name: 'attachment', contentType: 'text/x-amp-html', size: 300 },
    { messageId: message.id, ord: 1, fileId: named.id, name: 'email.amp.html', contentType: 'text/x-amp-html', size: 50 },
  ]);
  return { message, amp, named };
}

describe('purgeAlternativeBodyAttachments', () => {
  it('reports without writing in a dry run', async () => {
    const { message } = await fixture();
    const stats = await purgeAlternativeBodyAttachments({ apply: false });

    expect(stats.matched).toBeGreaterThanOrEqual(1);
    expect(mockUnlinkFile).not.toHaveBeenCalled();
    const rows = await getDb().select().from(messageAttachments).where(eq(messageAttachments.messageId, message.id));
    expect(rows).toHaveLength(2);
  });

  it('removes the unnamed AMP part, keeps a named one, and gives the bytes back', async () => {
    mockUnlinkFile.mockResolvedValue(undefined);
    const { message, amp } = await fixture();

    const stats = await purgeAlternativeBodyAttachments({ apply: true });
    expect(stats.errors).toBe(0);

    const rows = await getDb().select().from(messageAttachments).where(eq(messageAttachments.messageId, message.id));
    expect(rows.map((r) => r.name)).toEqual(['email.amp.html']);
    const [after] = await getDb().select({ size: messages.size }).from(messages).where(eq(messages.id, message.id));
    expect(after.size).toBe(1050);
    expect(mockUnlinkFile).toHaveBeenCalledWith(amp.id, 'oxy-mail', 'message', message.id);
    expect(mockUnlinkFile).toHaveBeenCalledWith(amp.id, 'oxy-mail', 'message', message.messageId);

    // Idempotent.
    expect((await purgeAlternativeBodyAttachments({ apply: true })).removed).toBe(0);
  });
});
