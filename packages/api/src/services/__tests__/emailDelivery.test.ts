/**
 * Sending a user's message, on a REAL Postgres, with only the SMTP transport
 * and the queue faked.
 *
 * A send is accepted (filed in Sent, job created, 202) without waiting on the
 * relay, and delivered afterwards. Pins:
 *   1. accepting never waits on SMTP — a relay that hangs forever does not hold
 *      the request;
 *   2. every delivery outcome lands on the message: sent (with the relay's
 *      substituted Message-ID), retrying (transient) → sent, failed (permanent,
 *      with the relay's words), failed after the retry budget;
 *   3. the same Idempotency-Key sent concurrently files ONE Sent row and goes
 *      out ONCE;
 *   4. the message coming back to its own sender is linked to the Sent row and
 *      the conversation shows it once.
 */

process.env.SMTP_RELAY_HOST = 'email-smtp.us-west-2.amazonaws.com';
process.env.SMTP_RELAY_USER = 'user';
process.env.SMTP_RELAY_PASS = 'pass';

const mockSendMail = jest.fn();
const mockScheduled: Array<{ outboxId: string; delayMs: number }> = [];

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args), close: jest.fn() }) },
}));
jest.mock('../../queue/emailDelivery.queue', () => ({
  registerEmailDeliveryProcessor: jest.fn(),
  scheduleEmailDelivery: (outboxId: string, delayMs = 0) => {
    mockScheduled.push({ outboxId, delayMs });
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

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailOutbox } from '../../db/schema/emailOutbox';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import {
  acceptOutboundMessage,
  deliverEmail,
  retryDelivery,
  type OutboundMessage,
} from '../emailDelivery.service';
import { EMAIL_OUTBOX_MAX_ATTEMPTS } from '../emailOutbox.service';

const unique = () => randomUUID().replace(/-/g, '');
const SES_ID = '010101a0e167f1da-8a9cef8c-7895-4d67-ace3-1b62e41ee6a2-000000';

let user: { id: string; username: string; address: string };

beforeAll(async () => {
  await connectPostgres();
  const username = `sender${unique().slice(0, 10)}`;
  const [row] = await getDb().insert(users).values({ username, color: 'teal' }).returning({ id: users.id });
  user = { id: row.id, username, address: `${username}@oxy.so` };
  await emailService.ensureMailboxes(user.id);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockSendMail.mockReset();
  mockScheduled.length = 0;
});

function reply(idempotencyKey?: string, parent = `<case-${unique()}@example.com>`): OutboundMessage {
  return {
    userId: user.id,
    from: { name: 'Nate', address: user.address },
    to: [{ name: '', address: 'support@example.com' }],
    subject: 'Re: Quota Increase',
    text: 'Thanks',
    inReplyTo: parent,
    references: [parent],
    idempotencyKey,
  };
}

async function sentRows(messageId: string) {
  return getDb().select().from(messages).where(and(eq(messages.userId, user.id), eq(messages.messageId, messageId)));
}

async function jobFor(messageId: string) {
  const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.messageId, messageId));
  return row;
}

/** Make a scheduled retry due now, as the passage of time would. */
async function makeDue(outboxId: string) {
  await getDb().update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(emailOutbox.id, outboxId));
}

/** Accept, then run the delivery the queue would have started. */
async function sendAndDeliver(message: OutboundMessage) {
  const accepted = await acceptOutboundMessage(message);
  const job = await jobFor(accepted.message.messageId);
  await deliverEmail(job.id);
  return { accepted, job };
}

describe('accepting a send', () => {
  it('files the message and answers without waiting on the relay', async () => {
    // A relay that never answers.
    mockSendMail.mockImplementation(() => new Promise(() => {}));

    const accepted = await acceptOutboundMessage(reply(`k:${unique()}`));

    expect(accepted.created).toBe(true);
    expect(accepted.message.delivery).toMatchObject({ state: 'sending', attempts: 0, error: null });
    expect(mockSendMail).not.toHaveBeenCalled();

    const job = await jobFor(accepted.message.messageId);
    expect(job).toMatchObject({ status: 'pending', messageRowId: accepted.message.id });
    expect(mockScheduled).toEqual([{ outboxId: job.id, delayMs: 0 }]);
  });

  it('files a concurrently retried key once and delivers it once', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID}` });
    const key = `reply:${unique()}`;

    const [a, b] = await Promise.all([acceptOutboundMessage(reply(key)), acceptOutboundMessage(reply(key))]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.message.id).toBe(b.message.id);
    expect(await sentRows(a.message.messageId)).toHaveLength(1);

    const job = await jobFor(a.message.messageId);
    await Promise.all([deliverEmail(job.id), deliverEmail(job.id)]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // A later retry of the same key returns the delivered message, sending nothing.
    const again = await acceptOutboundMessage(reply(key));
    expect(again).toMatchObject({ created: false, message: { id: a.message.id, delivery: { state: 'sent' } } });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('delivering it', () => {
  it('records the relay accepting it, with the Message-ID the relay substituted', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID}` });
    const { accepted, job } = await sendAndDeliver(reply(`k:${unique()}`));

    const [row] = await sentRows(accepted.message.messageId);
    expect(row).toMatchObject({
      deliveryState: 'sent',
      deliveryAttempts: 1,
      deliveryError: null,
      relayMessageId: `<${SES_ID}@us-west-2.amazonses.com>`,
    });
    expect((await jobFor(accepted.message.messageId)).status).toBe('sent');
    expect(mockSendMail.mock.calls[0][0].headers).toEqual({ 'X-Oxy-Sent-Id': accepted.message.messageId });
    expect(job.messageRowId).toBe(row.id);
  });

  it('retries a transient failure with backoff, then records the delivery', async () => {
    mockSendMail
      .mockRejectedValueOnce(Object.assign(new Error('421 4.3.0 Try again later'), { responseCode: 421 }))
      .mockResolvedValueOnce({ response: '250 Ok' });
    const { accepted, job } = await sendAndDeliver(reply(`k:${unique()}`));

    let [row] = await sentRows(accepted.message.messageId);
    expect(row).toMatchObject({
      deliveryState: 'retrying',
      deliveryAttempts: 1,
      deliveryErrorCode: 'relay_unavailable',
      deliveryError: '421 4.3.0 Try again later',
    });
    expect(row.deliveryNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(mockScheduled.at(-1)).toEqual({ outboxId: job.id, delayMs: 60_000 });

    // Not due yet: a stray job does nothing.
    await deliverEmail(job.id);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    await makeDue(job.id);
    await deliverEmail(job.id);
    [row] = await sentRows(accepted.message.messageId);
    expect(row).toMatchObject({ deliveryState: 'sent', deliveryAttempts: 2, deliveryError: null, deliveryErrorCode: null });
  });

  it('fails a permanent refusal at once, with the relay\'s words', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('554 5.7.1 Message rejected: Email address is not verified'), { responseCode: 554 }),
    );
    const { accepted } = await sendAndDeliver(reply(`k:${unique()}`));

    const [row] = await sentRows(accepted.message.messageId);
    expect(row).toMatchObject({
      deliveryState: 'failed',
      deliveryErrorCode: 'rejected',
      deliveryError: '554 5.7.1 Message rejected: Email address is not verified',
      deliveryNextAttemptAt: null,
    });
    expect(mockScheduled).toHaveLength(1); // the initial kick, no retry
  });

  it('fails after the retry budget is spent', async () => {
    mockSendMail.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const accepted = await acceptOutboundMessage(reply(`k:${unique()}`));
    const job = await jobFor(accepted.message.messageId);
    await getDb().update(emailOutbox).set({ attempts: EMAIL_OUTBOX_MAX_ATTEMPTS - 1 }).where(eq(emailOutbox.id, job.id));

    await deliverEmail(job.id);
    const [row] = await sentRows(accepted.message.messageId);
    expect(row).toMatchObject({ deliveryState: 'failed', deliveryErrorCode: 'retries_exhausted' });
  });

  it('lets the user retry a failed message with a fresh budget', async () => {
    mockSendMail
      .mockRejectedValueOnce(Object.assign(new Error('554 rejected'), { responseCode: 554 }))
      .mockResolvedValueOnce({ response: '250 Ok' });
    const { accepted, job } = await sendAndDeliver(reply(`k:${unique()}`));

    const retried = await retryDelivery(user.id, accepted.message.id);
    expect(retried.delivery).toMatchObject({ state: 'sending', attempts: 0, error: null });
    expect(mockScheduled.at(-1)).toEqual({ outboxId: job.id, delayMs: 0 });

    await deliverEmail(job.id);
    const [row] = await sentRows(accepted.message.messageId);
    expect(row.deliveryState).toBe('sent');
  });

  it('does not send a message the user deleted before it left', async () => {
    const accepted = await acceptOutboundMessage(reply(`k:${unique()}`));
    const job = await jobFor(accepted.message.messageId);
    await getDb().delete(messages).where(eq(messages.id, accepted.message.id));

    await deliverEmail(job.id);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect((await jobFor(accepted.message.messageId)).status).toBe('cancelled');
  });

  it('hands a scheduled message to the same delivery when its time comes', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const scheduled = await emailService.scheduleMessage(user.id, {
      ...reply(),
      scheduledAt: new Date(Date.now() + 60_000),
    });
    await getDb().update(messages).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(messages.id, scheduled.id));

    await emailService.processScheduledMessages();
    let [row] = await sentRows(scheduled.messageId);
    expect(row).toMatchObject({ scheduledAt: null, deliveryState: 'sending' });

    await deliverEmail((await jobFor(scheduled.messageId)).id);
    [row] = await sentRows(scheduled.messageId);
    expect(row.deliveryState).toBe('sent');
  });
});

describe('the sender receiving their own message', () => {
  it('links it to the Sent row, threads it by the relay id, and shows the conversation once', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID.replace('8a9c', 'aaaa')}` });
    const parent = `<case-${unique()}@example.com>`;
    const { accepted } = await sendAndDeliver({ ...reply(`k:${unique()}`, parent), to: [{ name: '', address: user.address }] });
    const sent = accepted.message;
    const [sentRow] = await sentRows(sent.messageId);

    // What comes back through the relay: SES's Message-ID, our header intact.
    const copy = await emailService.storeIncomingMessage({
      recipientUsername: user.username,
      from: { name: 'Nate', address: user.address },
      to: [{ address: user.address }],
      subject: 'Re: Quota Increase',
      text: 'Thanks',
      messageId: sentRow.relayMessageId!,
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
      inReplyTo: sentRow.relayMessageId!,
      date: new Date(),
      headers: {},
      rawSize: 100,
    });

    const thread = await emailService.getThread(user.id, answer.id);
    expect(thread.map((m) => m.id).sort()).toEqual([answer.id, sentRow.id].sort());
  });

  it('does not treat a stranger copying the header as a self-copy', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const { accepted: { message: sent } } = await sendAndDeliver(reply(`k:${unique()}`));
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
