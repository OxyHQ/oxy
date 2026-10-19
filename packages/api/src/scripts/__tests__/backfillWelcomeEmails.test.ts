import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { EMAIL_DOMAIN } from '../../config/email.config';
import { users } from '../../db/schema/users';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { messageRecipients } from '../../db/schema/messageRecipients';
import { renderWelcomeEmail } from '../../services/welcomeEmail';
import { backfillWelcomeEmails } from '../backfillWelcomeEmails';

let userId: string;
let mailboxId: string;
const originalDate = new Date('2025-01-02T12:00:00Z');
const address = `original-handle@${EMAIL_DOMAIN}`;
const oldText = `Hi Ana,\n\nWelcome to Inbox by Oxy — your new email, built for clarity.\n\nA few things to get you started:`;

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(async () => {
  const [user] = await getDb()
    .insert(users)
    .values({ username: `renamed-${randomUUID()}` })
    .returning({ id: users.id });
  userId = user.id;
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'Archive', path: 'Archive' })
    .returning({ id: mailboxes.id });
  mailboxId = mailbox.id;
});
afterEach(async () => {
  await getDb().delete(users).where(eq(users.id, userId));
});

async function seed(overrides: Partial<typeof messages.$inferInsert> = {}) {
  const [message] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<welcome-${userId}-${randomUUID()}@${EMAIL_DOMAIN}>`,
      fromName: 'Inbox by Oxy',
      fromAddress: `hello@${EMAIL_DOMAIN}`,
      subject: 'Welcome to Inbox by Oxy',
      text: oldText,
      html: '<p>Legacy welcome</p>',
      size: Buffer.byteLength(oldText),
      date: originalDate,
      receivedAt: originalDate,
      seen: true,
      pinned: true,
      starred: true,
      labels: ['keep'],
      ...overrides,
    })
    .returning({ id: messages.id });
  await getDb()
    .insert(messageRecipients)
    .values({ messageId: message.id, kind: 'to', ord: 0, name: 'Ana', address });
  return message.id;
}

async function read(id: string) {
  const [row] = await getDb()
    .select({
      id: messages.id,
      messageId: messages.messageId,
      mailboxId: messages.mailboxId,
      date: messages.date,
      receivedAt: messages.receivedAt,
      seen: messages.seen,
      pinned: messages.pinned,
      starred: messages.starred,
      labels: messages.labels,
      subject: messages.subject,
      text: messages.text,
      html: messages.html,
      size: messages.size,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .where(eq(messages.id, id));
  return row;
}

it('previews without changing the stored message', async () => {
  const id = await seed();
  const before = await read(id);
  expect(await backfillWelcomeEmails(getDb())).toEqual({
    candidates: 1,
    eligible: 1,
    unrecognised: 0,
    updated: 0,
  });
  expect(await read(id)).toEqual(before);
});

it('replaces content in place, preserves original identity and state, and is idempotent', async () => {
  const id = await seed();
  const before = await read(id);
  const ordinary = await seed({ messageId: `<ordinary-${randomUUID()}@${EMAIL_DOMAIN}>` });
  const ordinaryBefore = await read(ordinary);
  const newWelcome = await seed(renderWelcomeEmail('Ana', address));
  const newBefore = await read(newWelcome);
  const recipientsBefore = await getDb()
    .select()
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, id));

  expect(await backfillWelcomeEmails(getDb(), true)).toEqual({
    candidates: 1,
    eligible: 1,
    unrecognised: 0,
    updated: 1,
  });
  const content = renderWelcomeEmail('Ana', address);
  expect(await read(id)).toEqual({
    ...before,
    ...content,
    size: Buffer.byteLength(content.text),
    updatedAt: expect.any(Date),
  });
  expect(
    await getDb().select().from(messageRecipients).where(eq(messageRecipients.messageId, id)),
  ).toEqual(recipientsBefore);
  expect(await read(ordinary)).toEqual(ordinaryBefore);
  expect(await read(newWelcome)).toEqual(newBefore);
  expect(await backfillWelcomeEmails(getDb(), true)).toEqual({
    candidates: 0,
    eligible: 0,
    unrecognised: 0,
    updated: 0,
  });
});

it('rolls the entire cutover back if a candidate cannot be identified safely', async () => {
  const valid = await seed();
  const unknown = await seed({ text: 'Unrecognised welcome variant' });
  const before = await read(valid);
  const unknownBefore = await read(unknown);
  expect(await backfillWelcomeEmails(getDb())).toEqual({
    candidates: 2,
    eligible: 1,
    unrecognised: 1,
    updated: 0,
  });
  await expect(backfillWelcomeEmails(getDb(), true)).rejects.toThrow('rolled back');
  expect(await read(valid)).toEqual(before);
  expect(await read(unknown)).toEqual(unknownBefore);
});

it('preserves the first-name greeting from the original template with a full recipient name', async () => {
  const id = await seed();
  await getDb()
    .update(messageRecipients)
    .set({ name: 'Ana Example' })
    .where(eq(messageRecipients.messageId, id));
  expect(await backfillWelcomeEmails(getDb(), true)).toEqual({
    candidates: 1,
    eligible: 1,
    unrecognised: 0,
    updated: 1,
  });
  expect(await read(id)).toMatchObject(renderWelcomeEmail('Ana', address));
  const [recipient] = await getDb()
    .select({ name: messageRecipients.name })
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, id));
  expect(recipient.name).toBe('Ana Example');
});

it.each(['Anabelle Example', 'Unrelated Name'])(
  'refuses a mismatched historical greeting for %s',
  async (name) => {
    const id = await seed();
    await getDb()
      .update(messageRecipients)
      .set({ name })
      .where(eq(messageRecipients.messageId, id));
    const before = await read(id);
    await expect(backfillWelcomeEmails(getDb(), true)).rejects.toThrow('rolled back');
    expect(await read(id)).toEqual(before);
  },
);

it('updates every page of candidates without skipping rows as their subjects change', async () => {
  for (let i = 0; i < 101; i++) await seed();
  expect(await backfillWelcomeEmails(getDb(), true)).toEqual({
    candidates: 101,
    eligible: 101,
    unrecognised: 0,
    updated: 101,
  });
  expect(await backfillWelcomeEmails(getDb())).toEqual({
    candidates: 0,
    eligible: 0,
    unrecognised: 0,
    updated: 0,
  });
});
