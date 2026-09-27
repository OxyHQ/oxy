/**
 * Sending a user's message, on a REAL Postgres, with only the SMTP transport
 * faked.
 *
 * Pins the three things a reply got wrong in production on 2026-09-27:
 *   1. the same Idempotency-Key sent concurrently — a client retrying after its
 *      own timeout while the relay was still talking — goes out ONCE and files
 *      ONE Sent row;
 *   2. the relay's substituted Message-ID (SES) is kept on the Sent row, so the
 *      recipient's answer joins the conversation;
 *   3. the message coming back to its own sender is linked to the Sent row and
 *      the conversation shows it once.
 */

process.env.SMTP_RELAY_HOST = 'email-smtp.us-west-2.amazonaws.com';
process.env.SMTP_RELAY_USER = 'user';
process.env.SMTP_RELAY_PASS = 'pass';

const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args), close: jest.fn() }) },
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
import { smtpOutbound } from '../smtp.outbound';

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
});

function reply(idempotencyKey?: string, parent = `<case-${unique()}@example.com>`) {
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

describe('smtpOutbound.send', () => {
  it('sends a concurrently retried key once and files one Sent row', async () => {
    let release!: () => void;
    const relayAnswered = new Promise<void>((resolve) => { release = resolve; });
    mockSendMail.mockImplementation(async () => {
      await relayAnswered;
      return { response: `250 Ok ${SES_ID}` };
    });

    const key = `reply:${unique()}`;
    const first = smtpOutbound.send(reply(key));
    // The client gave up waiting and pressed Send again, same key.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await smtpOutbound.send(reply(key));
    expect(retry.queued).toBe(true);

    release();
    const sent = await first;
    expect(sent).toEqual({ messageId: retry.messageId, queued: false });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const rows = await sentRows(sent.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].relayMessageId).toBe(`<${SES_ID}@us-west-2.amazonses.com>`);

    const [outbox] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.messageId, sent.messageId));
    expect(outbox.status).toBe('sent');

    // A later retry of the same key reports the first outcome, without sending.
    expect(await smtpOutbound.send(reply(key))).toEqual({ messageId: sent.messageId, queued: false });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('stamps our Message-ID in X-Oxy-Sent-Id, which relays do not rewrite', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID}` });
    const { messageId } = await smtpOutbound.send(reply(`k:${unique()}`));
    expect(mockSendMail.mock.calls[0][0].headers).toEqual({ 'X-Oxy-Sent-Id': messageId });
  });

  it('gives the key back after a permanent refusal, so a corrected retry can send', async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('554 rejected'), { responseCode: 554 }));
    const key = `k:${unique()}`;
    await expect(smtpOutbound.send(reply(key))).rejects.toThrow('554 rejected');
    expect(await getDb().select().from(emailOutbox).where(eq(emailOutbox.idempotencyKey, key))).toHaveLength(0);

    mockSendMail.mockResolvedValueOnce({ response: '250 2.0.0 Ok: queued as ABC' });
    expect((await smtpOutbound.send(reply(key))).queued).toBe(false);
  });

  it('leaves a transient failure in the outbox for the worker, under the same claim', async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('421 try later'), { responseCode: 421 }));
    const key = `k:${unique()}`;
    const result = await smtpOutbound.send(reply(key));
    expect(result.queued).toBe(true);
    const rows = await getDb().select().from(emailOutbox).where(eq(emailOutbox.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });
});

describe('the sender receiving their own message', () => {
  it('links it to the Sent row, threads it by the relay id, and shows the conversation once', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID.replace('8a9c', 'aaaa')}` });
    const parent = `<case-${unique()}@example.com>`;
    const sent = await smtpOutbound.send({ ...reply(`k:${unique()}`, parent), to: [{ name: '', address: user.address }] });
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
    const sent = await smtpOutbound.send(reply(`k:${unique()}`));
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
