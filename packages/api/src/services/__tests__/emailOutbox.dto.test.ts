/**
 * What the outbox reads answer with, against a REAL Postgres: the outbox list,
 * a retry, a cancel, and the `delivery` on each Sent message. Every one is
 * compared EXACTLY with the row as stored in full, `payload` included, so a
 * read that loads fewer columns has to answer with the same thing.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailOutbox, type EmailOutboxPayload } from '../../db/schema/emailOutbox';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import {
  cancelEmailOutbox,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  listEmailOutbox,
  loadMessageDeliveries,
  retryEmailOutbox,
} from '../emailOutbox.service';

const unique = () => randomUUID().replace(/-/g, '');

type OutboxRow = typeof emailOutbox.$inferSelect;

const payload: EmailOutboxPayload = {
  from: { name: 'Nate', address: 'nate@oxy.so' },
  to: [{ name: '', address: 'support@example.com' }],
  subject: 'A body the reads never needed',
  text: 'x'.repeat(4096),
  html: `<p>${'x'.repeat(4096)}</p>`,
};

let userId: string;
let mailboxId: string;

beforeAll(async () => {
  await connectPostgres();
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  userId = user.id;
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'Sent', path: 'Sent' })
    .returning({ id: mailboxes.id });
  mailboxId = mailbox.id;
});

afterAll(async () => {
  // The worker's database is shared with the suites that run after this one,
  // and a delivery left due here would be claimed by their outbox worker.
  await getDb().delete(users).where(eq(users.id, userId));
  await closePostgres();
});

async function sentMessage(): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@oxy.so>`,
      fromAddress: 'nate@oxy.so',
      subject: 'Sent',
      size: 1,
      date: new Date(),
    })
    .returning({ id: messages.id });
  return row.id;
}

async function delivery(values: Partial<typeof emailOutbox.$inferInsert>): Promise<OutboxRow> {
  const [row] = await getDb()
    .insert(emailOutbox)
    .values({ userId, messageId: `<${unique()}@oxy.so>`, payload, ...values })
    .returning();
  return row;
}

async function stored(id: string): Promise<OutboxRow> {
  const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, id));
  return row;
}

/** The outbox DTO, written out field by field from the full row. */
function outboxDto(row: OutboxRow) {
  return {
    id: row.id,
    messageId: row.messageId,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
    terminal: row.status === 'failed' && row.attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

describe('the outbox list', () => {
  it('answers each delivery exactly as its full row reads', async () => {
    const sent = await delivery({ status: 'sent', attempts: 1, sentAt: new Date() });
    const failed = await delivery({
      status: 'failed',
      attempts: 2,
      lastError: '421 try later',
      errorCode: 'relay_unavailable',
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    const spent = await delivery({
      status: 'failed',
      attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
      lastError: '550 no such user',
      errorCode: 'rejected',
    });

    const listed = await listEmailOutbox(userId, 100);

    const byId = new Map(listed.map((dto) => [dto.id, dto]));
    for (const row of [sent, failed, spent]) {
      expect(byId.get(row.id)).toEqual(outboxDto(await stored(row.id)));
      expect(Object.keys(byId.get(row.id) ?? {})).toEqual(Object.keys(outboxDto(row)));
    }
    expect(byId.get(spent.id)?.terminal).toBe(true);
    expect(byId.get(failed.id)?.terminal).toBe(false);
  });
});

describe('retrying and cancelling', () => {
  it('answers a retry with the row as it now stands', async () => {
    const failed = await delivery({ status: 'failed', attempts: 3, lastError: 'gone' });

    const retried = await retryEmailOutbox(userId, failed.id);

    expect(retried).toEqual(outboxDto(await stored(failed.id)));
    expect(retried).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
  });

  it('answers a cancel with the row as it now stands', async () => {
    const pending = await delivery({ status: 'pending' });

    const cancelled = await cancelEmailOutbox(userId, pending.id);

    expect(cancelled).toEqual(outboxDto(await stored(pending.id)));
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('the delivery on a Sent message', () => {
  it('answers each state exactly, the newest delivery winning', async () => {
    const sending = await sentMessage();
    const retrying = await sentMessage();
    const bounced = await sentMessage();
    const twice = await sentMessage();
    await delivery({ messageRowId: sending, status: 'processing', attempts: 1 });
    const nextAttemptAt = new Date(Date.now() + 120_000);
    await delivery({
      messageRowId: retrying,
      status: 'failed',
      attempts: 2,
      lastError: '421 try later',
      errorCode: 'relay_unavailable',
      nextAttemptAt,
    });
    await delivery({
      messageRowId: bounced,
      status: 'failed',
      attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
      lastError: '550 mailbox unavailable',
      errorCode: 'bounced',
    });
    await delivery({ messageRowId: twice, status: 'cancelled', createdAt: new Date(0) });
    const newest = await delivery({ messageRowId: twice, status: 'sent', attempts: 1 });

    const deliveries = await loadMessageDeliveries(getDb(), [sending, retrying, bounced, twice]);

    const updatedAt = async (messageRowId: string) => {
      const rows = await getDb()
        .select({ updatedAt: emailOutbox.updatedAt, createdAt: emailOutbox.createdAt })
        .from(emailOutbox)
        .where(eq(emailOutbox.messageRowId, messageRowId));
      return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0].updatedAt;
    };
    const base = { maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS };
    expect(deliveries).toEqual(
      new Map([
        [
          sending,
          {
            ...base,
            attempts: 1,
            updatedAt: await updatedAt(sending),
            state: 'sending',
            nextAttemptAt: null,
            error: null,
            errorCode: null,
          },
        ],
        [
          retrying,
          {
            ...base,
            attempts: 2,
            updatedAt: await updatedAt(retrying),
            state: 'retrying',
            nextAttemptAt,
            error: '421 try later',
            errorCode: 'relay_unavailable',
          },
        ],
        [
          bounced,
          {
            ...base,
            attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
            updatedAt: await updatedAt(bounced),
            state: 'failed',
            nextAttemptAt: null,
            error: '550 mailbox unavailable',
            errorCode: 'bounced',
          },
        ],
        [
          twice,
          {
            ...base,
            attempts: 1,
            updatedAt: (await stored(newest.id)).updatedAt,
            state: 'sent',
            nextAttemptAt: null,
            error: null,
            errorCode: null,
          },
        ],
      ]),
    );
  });
});
