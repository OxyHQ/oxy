/**
 * A user's message, filed first and delivered afterwards — on a REAL Postgres,
 * with only the SMTP transport faked.
 *
 * Pins what a send must do now that the request no longer waits on the relay:
 *   1. the message is in Sent, with `delivery.state = 'sending'`, before the
 *      relay has answered — and the same Idempotency-Key sent concurrently goes
 *      out ONCE and files ONE Sent row;
 *   2. every outcome lands on that message (`sent`, `retrying`, `failed` with a
 *      code and the relay's words) and is announced as `email:changed`
 *      reason `delivery`;
 *   3. a failed delivery can be retried by message, unless a recipient has
 *      since been suppressed;
 *   4. an SES permanent bounce turns a `sent` message into a `bounced` one;
 *   5. the relay's substituted Message-ID (SES) is kept on the Sent row, so the
 *      recipient's answer joins the conversation, and the message coming back
 *      to its own sender is linked to the Sent row.
 */

process.env.SMTP_RELAY_HOST = 'email-smtp.us-west-2.amazonaws.com';
process.env.SMTP_RELAY_USER = 'user';
process.env.SMTP_RELAY_PASS = 'pass';

const mockSendMail = jest.fn();
const mockEmitChanged = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: () => ({
      sendMail: (...args: unknown[]) => mockSendMail(...args),
      close: jest.fn(),
    }),
  },
}));
jest.mock('../assetServiceSingleton', () => ({
  assetService: { uploadFileDirect: jest.fn(), linkFile: jest.fn(), getFileBuffer: jest.fn() },
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn().mockReturnValue(true) },
}));
jest.mock('../cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../emailPushDelivery.service', () => ({
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../inboxRealtime', () => ({
  ...jest.requireActual('../inboxRealtime'),
  emitEmailChanged: (...args: unknown[]) => mockEmitChanged(...args),
  emitEmailNew: jest.fn(),
}));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailOutbox } from '../../db/schema/emailOutbox';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import {
  acceptOutboundMessage,
  recordBouncedDelivery,
  retryMessageDelivery,
} from '../emailDelivery.service';
import { EMAIL_OUTBOX_MAX_ATTEMPTS, toMessageDelivery } from '../emailOutbox.service';
import { processEmailOutbox } from '../emailOutbox.worker';
import { recordSuppression } from '../emailSuppression.service';

const unique = () => randomUUID().replace(/-/g, '');
const SES_ID = '010101a0e167f1da-8a9cef8c-7895-4d67-ace3-1b62e41ee6a2-000000';

let user: { id: string; username: string; address: string };

beforeAll(async () => {
  await connectPostgres();
  const username = `sender${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  user = { id: row.id, username, address: `${username}@oxy.so` };
  await emailService.ensureMailboxes(user.id);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockSendMail.mockReset();
  mockEmitChanged.mockReset();
});

function reply(idempotencyKey?: string, parent = `<case-${unique()}@example.com>`) {
  return {
    userId: user.id,
    from: { name: 'Nate', address: user.address },
    to: [{ name: '', address: `support-${unique().slice(0, 8)}@example.com` }],
    subject: 'Re: Quota Increase',
    text: 'Thanks',
    inReplyTo: parent,
    references: [parent],
    idempotencyKey,
  };
}

async function sentRows(messageId: string) {
  return getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.messageId, messageId)));
}

/** Accept a send that files a Sent row, as every send here does. */
async function accept(message: Parameters<typeof acceptOutboundMessage>[0]) {
  const accepted = await acceptOutboundMessage(message);
  if (!accepted.messageRowId) throw new Error('the send filed no Sent row');
  return { ...accepted, rowId: accepted.messageRowId };
}

async function deliveryOf(messageRowId: string) {
  return (await emailService.getMessage(user.id, messageRowId))?.delivery;
}

/** The background delivery has no handle to await; wait for its outcome. */
async function settled(messageRowId: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const delivery = await deliveryOf(messageRowId);
    if (delivery?.state === state) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`delivery of ${messageRowId} never reached ${state}`);
}

function deliveryEvents(messageRowId: string) {
  return mockEmitChanged.mock.calls.filter(
    ([event]) => event.reason === 'delivery' && event.id === messageRowId,
  );
}

describe('accepting a send', () => {
  it('files it as sending before the relay answers, then records it as sent', async () => {
    let release!: () => void;
    const relayAnswered = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSendMail.mockImplementation(async () => {
      await relayAnswered;
      return { response: `250 Ok ${SES_ID}` };
    });

    const accepted = await accept(reply(`k:${unique()}`));
    expect(accepted.delivery?.state).toBe('sending');
    const rowId = accepted.rowId;

    // In Sent, and every read of it says it has not left yet.
    expect(await deliveryOf(rowId)).toMatchObject({ state: 'sending', attempts: 1 });

    release();
    const delivery = await settled(rowId, 'sent');
    expect(delivery).toMatchObject({ error: null, errorCode: null, nextAttemptAt: null });

    const [row] = await sentRows(accepted.messageId);
    expect(row.relayMessageId).toBe(`<${SES_ID}@us-west-2.amazonses.com>`);
    expect(deliveryEvents(rowId)).toHaveLength(1);
  });

  it('sends a concurrently retried key once and files one Sent row', async () => {
    let release!: () => void;
    const relayAnswered = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSendMail.mockImplementation(async () => {
      await relayAnswered;
      return { response: '250 2.0.0 Ok: queued as ABC' };
    });

    const key = `reply:${unique()}`;
    const [first, second] = await Promise.all([
      accept(reply(key)),
      acceptOutboundMessage(reply(key)),
    ]);
    expect(second.messageId).toBe(first.messageId);
    // The loser may answer before the winner has filed the row; it never names another.
    expect([first.messageRowId, null]).toContain(second.messageRowId);

    release();
    await settled(first.rowId, 'sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(await sentRows(first.messageId)).toHaveLength(1);

    // A later retry of the same key reports the outcome, without sending.
    const later = await acceptOutboundMessage(reply(key));
    expect(later.delivery?.state).toBe('sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('stamps our Message-ID in X-Oxy-Sent-Id, which relays do not rewrite', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID}` });
    const { messageId, rowId } = await accept(reply(`k:${unique()}`));
    await settled(rowId, 'sent');
    expect(mockSendMail.mock.calls[0][0].headers).toEqual({ 'X-Oxy-Sent-Id': messageId });
  });
});

describe('a delivery that fails', () => {
  it('keeps a permanent refusal on the message, with its code and the relay`s words', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('554 5.7.1 Message rejected'), { responseCode: 554 }),
    );
    const { rowId } = await accept(reply(`k:${unique()}`));
    const delivery = await settled(rowId, 'failed');
    expect(delivery).toMatchObject({
      errorCode: 'rejected',
      error: '554 5.7.1 Message rejected',
      attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
    });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure through the worker, still as one Sent row', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('421 try later'), { responseCode: 421 }),
    );
    const { messageId, rowId } = await accept(reply(`k:${unique()}`));
    const retrying = await settled(rowId, 'retrying');
    expect(retrying.errorCode).toBe('relay_unavailable');
    expect(retrying.nextAttemptAt).not.toBeNull();

    // The next attempt falls due.
    await getDb()
      .update(emailOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(emailOutbox.messageRowId, rowId));
    mockSendMail.mockResolvedValueOnce({ response: '250 Ok' });
    await processEmailOutbox();

    expect(await deliveryOf(rowId)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(await sentRows(messageId)).toHaveLength(1);
  });

  it('can be retried by message, and then goes out', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('535 bad credentials'), { code: 'EAUTH', responseCode: 535 }),
    );
    const { rowId } = await accept(reply(`k:${unique()}`));
    expect((await settled(rowId, 'failed')).errorCode).toBe('relay_auth');

    mockSendMail.mockResolvedValueOnce({ response: '250 Ok' });
    const retried = await retryMessageDelivery(user.id, rowId);
    expect(retried.id).toBe(messageRowId);
    await settled(rowId, 'sent');
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it('refuses a retry to a recipient suppressed since', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('550 no such user'), { responseCode: 550 }),
    );
    const message = reply(`k:${unique()}`);
    const { rowId } = await accept(message);
    await settled(rowId, 'failed');
    await recordSuppression({
      address: message.to[0].address,
      reason: 'bounce_permanent',
      source: 'ses',
      userId: null,
    });

    await expect(retryMessageDelivery(user.id, rowId)).rejects.toThrow(/Cannot retry/);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('refuses to retry a message that was delivered', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const { rowId } = await accept(reply(`k:${unique()}`));
    await settled(rowId, 'sent');
    await expect(retryMessageDelivery(user.id, rowId)).rejects.toThrow(
      /already being delivered or was delivered/,
    );
  });
});

describe('a permanent bounce after the relay took it', () => {
  it('marks the Sent message as not delivered, and only the sender`s', async () => {
    const sesId = `0101${unique().slice(0, 12)}-${unique().slice(0, 8)}-000000`;
    mockSendMail.mockResolvedValue({ response: `250 Ok ${sesId}` });
    const { rowId } = await accept(reply(`k:${unique()}`));
    await settled(rowId, 'sent');

    expect(
      await recordBouncedDelivery({
        userId: user.id,
        sesMessageId: sesId,
        detail: 'gone@example.com: 550 5.1.1 user unknown',
      }),
    ).toBe(1);
    expect(await deliveryOf(rowId)).toMatchObject({
      state: 'failed',
      errorCode: 'bounced',
      error: 'gone@example.com: 550 5.1.1 user unknown',
    });
    expect(deliveryEvents(rowId).length).toBeGreaterThanOrEqual(2);

    // An id that is not an SES id never reaches the LIKE.
    expect(await recordBouncedDelivery({ userId: user.id, sesMessageId: '%', detail: 'x' })).toBe(
      0,
    );
  });
});

describe('a scheduled send', () => {
  it('is delivered through the outbox and reports its delivery', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const scheduled = await emailService.scheduleMessage(user.id, {
      from: { name: 'Nate', address: user.address },
      to: [{ name: '', address: 'later@example.com' }],
      subject: 'Later',
      text: 'Hi',
      scheduledAt: new Date(Date.now() + 3_600_000),
    });
    await getDb()
      .update(messages)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(messages.id, scheduled.id));

    await emailService.processScheduledMessages();
    expect(await deliveryOf(scheduled.id)).toMatchObject({ state: 'sent' });
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Taken off the schedule: a second pass sends nothing.
    await emailService.processScheduledMessages();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('toMessageDelivery', () => {
  const row = (overrides: Partial<typeof emailOutbox.$inferSelect>) =>
    ({
      id: 'o',
      userId: 'u',
      messageRowId: 'm',
      messageId: '<m@oxy.so>',
      idempotencyKey: null,
      payload: { from: { name: '', address: 'a@oxy.so' }, to: [], subject: '' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date('2026-10-12T10:00:00Z'),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      errorCode: null,
      sentAt: null,
      createdAt: new Date('2026-10-12T09:00:00Z'),
      updatedAt: new Date('2026-10-12T09:00:00Z'),
      ...overrides,
    }) as typeof emailOutbox.$inferSelect;

  it('reads the first attempt as sending and a later one as retrying', () => {
    expect(toMessageDelivery(row({ status: 'processing', attempts: 1 })).state).toBe('sending');
    expect(toMessageDelivery(row({ status: 'processing', attempts: 3 })).state).toBe('retrying');
  });

  it('reads a transient failure with budget left as retrying, with when', () => {
    expect(
      toMessageDelivery(
        row({ status: 'failed', attempts: 2, lastError: '421', errorCode: 'relay_unavailable' }),
      ),
    ).toMatchObject({
      state: 'retrying',
      nextAttemptAt: new Date('2026-10-12T10:00:00Z'),
      errorCode: 'relay_unavailable',
    });
  });

  it('reads a spent budget of transient failures as retries_exhausted', () => {
    expect(
      toMessageDelivery(
        row({
          status: 'failed',
          attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
          errorCode: 'relay_unavailable',
        }),
      ),
    ).toMatchObject({ state: 'failed', errorCode: 'retries_exhausted', nextAttemptAt: null });
  });

  it('reads a cancelled delivery as failed, cancelled', () => {
    expect(toMessageDelivery(row({ status: 'cancelled' }))).toMatchObject({
      state: 'failed',
      errorCode: 'cancelled',
    });
  });
});

describe('the sender receiving their own message', () => {
  it('links it to the Sent row, threads it by the relay id, and shows the conversation once', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID.replace('8a9c', 'aaaa')}` });
    const parent = `<case-${unique()}@example.com>`;
    const sent = await accept({
      ...reply(`k:${unique()}`, parent),
      to: [{ name: '', address: user.address }],
    });
    await settled(sent.rowId, 'sent');
    const [sentRow] = await sentRows(sent.messageId);
    const relayId = sentRow.relayMessageId;
    if (!relayId) throw new Error('the relay id was not recorded');

    // What comes back through the relay: SES's Message-ID, our header intact.
    const copy = await emailService.storeIncomingMessage({
      recipientUsername: user.username,
      from: { name: 'Nate', address: user.address },
      to: [{ address: user.address }],
      subject: 'Re: Quota Increase',
      text: 'Thanks',
      messageId: relayId,
      inReplyTo: parent,
      references: [parent],
      date: new Date(),
      headers: { 'x-oxy-sent-id': sent.messageId },
      rawSize: 100,
    });
    const [copyRow] = await getDb().select().from(messages).where(eq(messages.id, copy.id));
    expect(copyRow.sentCopyOf).toBe(sentRow.id);

    // An answer to the relay's id joins the same conversation.
    const answer = await emailService.storeIncomingMessage({
      recipientUsername: user.username,
      from: { address: 'support@example.com' },
      to: [{ address: user.address }],
      subject: 'Re: Re: Quota Increase',
      text: 'Done',
      messageId: `<answer-${unique()}@example.com>`,
      inReplyTo: relayId,
      date: new Date(),
      headers: {},
      rawSize: 100,
    });

    const thread = await emailService.getThread(user.id, answer.id);
    expect(thread.map((m) => m.id).sort()).toEqual([answer.id, sentRow.id].sort());
  });

  it('does not treat a stranger copying the header as a self-copy', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const sent = await accept(reply(`k:${unique()}`));
    await settled(sent.rowId, 'sent');
    const forged = await emailService.storeIncomingMessage({
      recipientUsername: user.username,
      from: { address: 'mallory@example.com' },
      to: [{ address: user.address }],
      subject: 'hi',
      text: 'hi',
      messageId: `<forged-${unique()}@example.com>`,
      date: new Date(),
      headers: { 'x-oxy-sent-id': sent.messageId },
      rawSize: 100,
    });
    const [row] = await getDb().select().from(messages).where(eq(messages.id, forged.id));
    expect(row.sentCopyOf).toBeNull();
  });
});
