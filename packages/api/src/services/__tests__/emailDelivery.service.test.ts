/**
 * A user's message, filed first and delivered afterwards — on a REAL Postgres,
 * with only the SMTP transport faked.
 *
 * Pins what a send must do now that the request no longer waits on the relay:
 *   1. the message is in Sent, with `delivery.state = 'sending'`, before the
 *      relay has answered — and the same Idempotency-Key sent concurrently goes
 *      out ONCE and files ONE Sent row, even when the first send is refused or
 *      dies while the repeat waits on it; a repeat never waits unbounded, and
 *      the key reused for a different message is refused (a scheduled send
 *      too, compared with its filed row), its draft kept;
 *      a delivery the relay took is never offered to it again by the worker;
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

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { EMAIL_QUOTAS } from '../../config/email.config';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { sendMessageForUser } from '../../controllers/email.controller';
import { billingSubscriptions } from '../../db/schema/billingSubscriptions';
import { emailOutbox } from '../../db/schema/emailOutbox';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import {
  acceptOutboundMessage,
  recordBouncedDelivery,
  retryMessageDelivery,
} from '../emailDelivery.service';
import {
  cancelEmailOutbox,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  listEmailOutbox,
  retryEmailOutbox,
  toMessageDelivery,
} from '../emailOutbox.service';
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

/**
 * A reply. The same key always builds the same message — a repeat of a key is
 * a retry of one message, and a key reused for another is refused.
 */
function reply(idempotencyKey?: string, parent?: string) {
  const seed = idempotencyKey
    ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12)
    : unique().slice(0, 12);
  const thread = parent ?? `<case-${seed}@example.com>`;
  return {
    userId: user.id,
    from: { name: 'Nate', address: user.address },
    to: [{ name: '', address: `support-${seed}@example.com` }],
    subject: 'Re: Quota Increase',
    text: 'Thanks',
    inReplyTo: thread,
    references: [thread],
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

/** Backends of this test database waiting on a lock. */
async function lockWaiters(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0].n;
}

async function waitFor(condition: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition never held');
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** Hold the locks `take` takes, on a connection of its own, until released. */
function holdLock(take: (tx: Tx) => Promise<unknown>) {
  let held!: () => void;
  let release!: () => void;
  const heldPromise = new Promise<void>((resolve) => {
    held = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = getDb().transaction(async (tx) => {
    await take(tx);
    held();
    await released;
  });
  return {
    held: heldPromise,
    release: async () => {
      release();
      await done;
    },
  };
}

/**
 * Hold `FOR UPDATE` on the user's Sent mailbox: a send stops exactly where it
 * files its Sent copy (that insert takes a key-share lock on its mailbox),
 * holding its claim.
 */
async function holdSentFiling() {
  const sent = await emailService.getMailboxBySpecialUse(user.id, '\\Sent');
  if (!sent) throw new Error('no Sent mailbox');
  const gate = holdLock((tx) =>
    tx.select().from(mailboxes).where(eq(mailboxes.id, sent.id)).for('update'),
  );
  await gate.held;
  return gate;
}

/**
 * Hold `FOR UPDATE` on the user's row: a send stops right after inserting its
 * claim (the claim's foreign key takes a key-share lock on the user), before
 * it has checked the quota.
 */
async function holdClaimCheck() {
  const gate = holdLock((tx) => tx.select().from(users).where(eq(users.id, user.id)).for('update'));
  await gate.held;
  return gate;
}

/** Store a received message as big as the free tier's whole quota. */
async function fillMailbox(): Promise<() => Promise<void>> {
  const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
  if (!inbox) throw new Error('no Inbox');
  const [filler] = await getDb()
    .insert(messages)
    .values({
      userId: user.id,
      mailboxId: inbox.id,
      messageId: `<filler-${unique()}@example.com>`,
      fromAddress: 'filler@example.com',
      subject: 'filler',
      size: EMAIL_QUOTAS.free.storage,
      date: new Date(),
      receivedAt: new Date(),
    })
    .returning({ id: messages.id });
  return async () => {
    await getDb().delete(messages).where(eq(messages.id, filler.id));
  };
}

/** What the relay was handed for one message. */
function relayCallsFor(messageId: string) {
  return mockSendMail.mock.calls.filter(([mail]) => mail.messageId === messageId);
}

/** Whether a row is still one of this user's drafts. */
async function isDraft(id: string) {
  const rows = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.draft, true)));
  return rows.length === 1;
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
    // Either may win the claim; both answers name the one Sent row.
    const [first, second] = await Promise.all([accept(reply(key)), accept(reply(key))]);
    expect(second.messageId).toBe(first.messageId);
    expect(second.rowId).toBe(first.rowId);

    release();
    await settled(first.rowId, 'sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(await sentRows(first.messageId)).toHaveLength(1);

    // A later retry of the same key reports the outcome, without sending.
    const later = await acceptOutboundMessage(reply(key));
    expect(later.delivery?.state).toBe('sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('answers a repeat that arrives while the first is still filing with the filed row', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const gate = await holdSentFiling();

    const first = accept(reply(key));
    await waitFor(async () => (await lockWaiters()) >= 1);

    // The repeat either answers at once or waits behind the first's claim;
    // only then may the first finish filing.
    let secondDone = false;
    const second = accept(reply(key)).finally(() => {
      secondDone = true;
    });
    await waitFor(async () => secondDone || (await lockWaiters()) >= 2);
    await gate.release();

    const [a, b] = await Promise.all([first, second]);
    expect(b.messageId).toBe(a.messageId);
    expect(b.rowId).toBe(a.rowId);
    await settled(a.rowId, 'sent');
    expect(await sentRows(a.messageId)).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('refuses a send over quota without keeping its key, which then goes out once', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const emptyMailbox = await fillMailbox();
    try {
      await expect(acceptOutboundMessage(reply(key))).rejects.toThrow(/quota exceeded/);
    } finally {
      await emptyMailbox();
    }
    const claims = await getDb()
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, user.id), eq(emailOutbox.idempotencyKey, key)));
    expect(claims).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();

    const { messageId, rowId } = await accept(reply(key));
    await settled(rowId, 'sent');
    expect(await sentRows(messageId)).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('makes the attempt itself when the first send dies while the repeat waits on its claim', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const gate = await holdSentFiling();
    try {
      const first = accept(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 1);
      const second = accept(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 2);

      // The first send's connection is cancelled mid-filing, as a task that
      // dies or a statement that is killed would leave it.
      const [filing] = await getDb().execute<{ pid: number }>(
        sql`select pid from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query ilike 'insert into "messages"%'`,
      );
      await getDb().execute(sql`select pg_cancel_backend(${filing.pid})`);
      await expect(first).rejects.toThrow();

      await gate.release();
      const { messageId, rowId } = await second;
      await settled(rowId, 'sent');
      expect(await sentRows(messageId)).toHaveLength(1);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    } finally {
      await gate.release();
    }
  });

  it('makes the attempt itself when the first send is refused while the repeat waits on its claim', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const emptyMailbox = await fillMailbox();
    const [plan] = await getDb()
      .insert(billingSubscriptions)
      .values({
        userId: user.id,
        stripeCustomerId: `cus_${unique()}`,
        stripeSubscriptionId: `sub_${unique()}`,
        stripePriceId: 'price_pro',
        status: 'incomplete',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        planName: 'Pro',
        planCreditsPerMonth: 0,
        planPriceMinorUnits: 0,
      })
      .returning({ id: billingSubscriptions.id });
    const gate = await holdClaimCheck();
    try {
      // The first send reads the free tier's quota, which the mailbox already
      // fills, and stops holding its claim.
      const first = acceptOutboundMessage(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 1);
      // The plan starts; the repeat reads the bigger quota and waits on the claim.
      await getDb()
        .update(billingSubscriptions)
        .set({ status: 'active' })
        .where(eq(billingSubscriptions.id, plan.id));
      const second = accept(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 2);

      await gate.release();
      await expect(first).rejects.toThrow(/quota exceeded/);
      const { messageId, rowId } = await second;
      await settled(rowId, 'sent');
      expect(await sentRows(messageId)).toHaveLength(1);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    } finally {
      await gate.release();
      await getDb().delete(billingSubscriptions).where(eq(billingSubscriptions.id, plan.id));
      await emptyMailbox();
    }
  });

  it('refuses the key reused for a different message, and sends only the first', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const first = await accept(reply(key));

    // The refusal names the message the key already sent, so a client can say so.
    await expect(
      acceptOutboundMessage({ ...reply(key), text: 'Something else entirely' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: {
        reason: 'idempotency_key_reused',
        id: first.rowId,
        messageId: first.messageId,
      },
    });
    await expect(
      acceptOutboundMessage({ ...reply(key), to: [{ name: '', address: 'other@example.com' }] }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // The same message under the key is still a retry of the first.
    const again = await accept(reply(key));
    expect(again.rowId).toBe(first.rowId);
    await settled(first.rowId, 'sent');
    expect(await sentRows(first.messageId)).toHaveLength(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('refuses a different message under the key while the first is still filing', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const gate = await holdSentFiling();
    try {
      const first = accept(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 1);
      const other = acceptOutboundMessage({ ...reply(key), text: 'Something else entirely' }).then(
        () => 'accepted',
        (error: unknown) => error,
      );
      await waitFor(async () => (await lockWaiters()) >= 2);
      await gate.release();

      expect(await other).toMatchObject({ statusCode: 422 });
      const { rowId } = await first;
      await settled(rowId, 'sent');
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    } finally {
      await gate.release();
    }
  });

  it('answers a repeat stuck behind a stalled first send with a retryable 503, bounded', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const fileSentMessage = emailService.fileSentMessage.bind(emailService);
    let stalled!: () => void;
    const isStalled = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let settings: unknown;
    // The first send's task stops answering with its transaction open, claim held.
    const spy = jest
      .spyOn(emailService, 'fileSentMessage')
      .mockImplementationOnce(async (tx, ...rest) => {
        settings = (
          await tx.execute(
            sql`select current_setting('lock_timeout') as lock,
                       current_setting('idle_in_transaction_session_timeout') as idle`,
          )
        )[0];
        stalled();
        await resumed;
        return fileSentMessage(tx, ...rest);
      });
    try {
      const first = accept(reply(key));
      await isStalled;

      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const repeat = await Promise.race([
        acceptOutboundMessage(reply(key)).then(
          () => 'answered',
          (error: unknown) => error,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('still waiting after 10s'), 10_000);
        }),
      ]);
      clearTimeout(timer);
      expect(repeat).toMatchObject({ statusCode: 503, details: { retryable: true } });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      // And a first send whose task is gone ends its own session, freeing the claim.
      expect(settings).toEqual({ lock: '5s', idle: '15s' });

      // The client retries with the same key once the first has filed.
      resume();
      const filed = await first;
      const retried = await accept(reply(key));
      expect(retried.rowId).toBe(filed.rowId);
      await settled(filed.rowId, 'sent');
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    } finally {
      resume();
      spy.mockRestore();
    }
  }, 30_000);

  it('stamps our Message-ID in X-Oxy-Sent-Id, which relays do not rewrite', async () => {
    mockSendMail.mockResolvedValue({ response: `250 Ok ${SES_ID}` });
    const { messageId, rowId } = await accept(reply(`k:${unique()}`));
    await settled(rowId, 'sent');
    const [[mail]] = relayCallsFor(messageId);
    expect(mail.headers).toEqual({ 'X-Oxy-Sent-Id': messageId });
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
    expect(retried.id).toBe(rowId);
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

describe('a delivery whose task died', () => {
  const LEASE_EXPIRED = () => new Date(Date.now() - 11 * 60_000);

  /** A claim taken before sends were filed first: no Sent copy, no link. */
  async function legacyClaim(overrides: Partial<typeof emailOutbox.$inferInsert> = {}) {
    const messageId = `<legacy-${unique()}@oxy.so>`;
    const [row] = await getDb()
      .insert(emailOutbox)
      .values({
        userId: user.id,
        messageId,
        payload: {
          from: { name: 'Nate', address: user.address },
          to: [{ name: '', address: `legacy-${unique().slice(0, 8)}@example.com` }],
          subject: 'Legacy',
          text: 'Sent before sends were filed first',
        },
        status: 'processing',
        attempts: 1,
        lockedAt: LEASE_EXPIRED(),
        lockedBy: 'request:dead',
        ...overrides,
      })
      .returning();
    return row;
  }

  async function outboxRow(id: string) {
    const [row] = await getDb().select().from(emailOutbox).where(eq(emailOutbox.id, id));
    return row;
  }

  it('is sent once even when its Sent copy no longer fits, and never again', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const row = await legacyClaim();
    const emptyMailbox = await fillMailbox();
    try {
      await processEmailOutbox().catch(() => undefined);
      expect(relayCallsFor(row.messageId)).toHaveLength(1);
      expect(await outboxRow(row.id)).toMatchObject({ status: 'sent', lockedAt: null });

      // Lease after lease, the worker never offers it to the relay again.
      for (let pass = 0; pass < 3; pass++) {
        await getDb()
          .update(emailOutbox)
          .set({ lockedAt: LEASE_EXPIRED() })
          .where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, 'processing')));
        await processEmailOutbox().catch(() => undefined);
      }
      expect(relayCallsFor(row.messageId)).toHaveLength(1);
    } finally {
      await emptyMailbox();
    }
  });

  it('files the Sent copy of a legacy delivery when it fits, linked to it', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const row = await legacyClaim();
    await processEmailOutbox();
    const [filed] = await sentRows(row.messageId);
    expect(await outboxRow(row.id)).toMatchObject({ status: 'sent', messageRowId: filed.id });
    expect(await deliveryOf(filed.id)).toMatchObject({ state: 'sent' });
  });

  it('is not adopted once its attempts are spent, and reads as failed', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const { messageId, rowId } = await accept(reply(`k:${unique()}`));
    await settled(rowId, 'sent');
    mockSendMail.mockClear();
    // Its last attempt's task died mid-delivery.
    await getDb()
      .update(emailOutbox)
      .set({
        status: 'processing',
        attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
        lockedAt: LEASE_EXPIRED(),
        sentAt: null,
      })
      .where(eq(emailOutbox.messageRowId, rowId));

    await processEmailOutbox();
    expect(relayCallsFor(messageId)).toHaveLength(0);
    expect(await deliveryOf(rowId)).toMatchObject({
      state: 'failed',
      errorCode: 'retries_exhausted',
    });
    expect(deliveryEvents(rowId).length).toBeGreaterThanOrEqual(1);
  });
});

describe('the draft a send was written in', () => {
  it('is removed by the send, and kept when the key was already used for another message', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `compose:${unique()}`;
    const to = [{ name: '', address: `drafted-${unique().slice(0, 8)}@example.com` }];
    const message = { to, subject: 'Hello', text: 'First' };

    const first = await emailService.saveDraft(user.id, message);
    const sent = await sendMessageForUser(user.id, { ...message, draftId: first.id }, key);
    expect(sent.status).toBe(202);
    expect(await isDraft(first.id)).toBe(false);

    // Another message under the same key: refused, and its draft is kept.
    const other = await emailService.saveDraft(user.id, { ...message, text: 'Second' });
    await expect(
      sendMessageForUser(user.id, { ...message, text: 'Second', draftId: other.id }, key),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await isDraft(other.id)).toBe(true);

    // The same message again (a retry, with a draft an autosave raced in) is
    // answered with the first send, and that draft has done its job.
    const raced = await emailService.saveDraft(user.id, message);
    const retried = await sendMessageForUser(user.id, { ...message, draftId: raced.id }, key);
    expect(retried.data.id).toBe(sent.data.id);
    expect(await isDraft(raced.id)).toBe(false);

    await settled(sent.data.id as string, 'sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
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

  const later = () => new Date(Date.now() + 3_600_000);

  it('answers a repeat of its key with the filed row, and refuses another message under it', async () => {
    const key = `schedule:${unique()}`;
    const message = {
      from: { name: 'Nate', address: user.address },
      to: [{ name: 'Ana', address: `ana-${unique().slice(0, 8)}@example.com` }],
      subject: 'Later',
      text: 'Hi',
      idempotencyKey: key,
    };
    const first = await emailService.scheduleMessage(user.id, { ...message, scheduledAt: later() });

    // The same message, as the Sent row stores it, is a retry.
    const retried = await emailService.scheduleMessage(user.id, {
      ...message,
      to: [{ name: ' Ana ', address: message.to[0].address.toUpperCase() }],
      scheduledAt: later(),
    });
    expect(retried.id).toBe(first.id);

    for (const other of [
      { text: 'Something else entirely' },
      { to: [{ name: '', address: 'other@example.com' }] },
      { subject: 'Sooner' },
    ]) {
      await expect(
        emailService.scheduleMessage(user.id, { ...message, ...other, scheduledAt: later() }),
      ).rejects.toMatchObject({ statusCode: 422, details: { reason: 'idempotency_key_reused' } });
    }
    expect(await sentRows(first.messageId)).toHaveLength(1);
  });

  it('refuses an immediate send of another message under a scheduled send`s key', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `k:${unique()}`;
    const scheduled = await emailService.scheduleMessage(user.id, {
      ...reply(key),
      scheduledAt: later(),
    });

    await expect(
      acceptOutboundMessage({ ...reply(key), text: 'Something else entirely' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    // The same message is answered with the scheduled row, and nothing is sent.
    const same = await acceptOutboundMessage(reply(key));
    expect(same.messageRowId).toBe(scheduled.id);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('keeps the draft of another message scheduled under a used key', async () => {
    const key = `compose:${unique()}`;
    const to = [{ name: '', address: `scheduled-${unique().slice(0, 8)}@example.com` }];
    const message = { to, subject: 'Hello', text: 'First' };
    const scheduledAt = later().toISOString();

    const first = await emailService.saveDraft(user.id, message);
    const scheduled = await sendMessageForUser(
      user.id,
      { ...message, scheduledAt, draftId: first.id },
      key,
    );
    expect(scheduled.status).toBe(202);
    expect(await isDraft(first.id)).toBe(false);

    const other = await emailService.saveDraft(user.id, { ...message, text: 'Second' });
    await expect(
      sendMessageForUser(
        user.id,
        { ...message, text: 'Second', scheduledAt, draftId: other.id },
        key,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await isDraft(other.id)).toBe(true);

    // A retry of the first, with a draft an autosave raced in, is answered.
    const raced = await emailService.saveDraft(user.id, message);
    const retried = await sendMessageForUser(
      user.id,
      { ...message, scheduledAt, draftId: raced.id },
      key,
    );
    expect(retried.data.messageId).toBe(scheduled.data.messageId);
    expect(await isDraft(raced.id)).toBe(false);
  });
});

describe('a scheduled send under a key', () => {
  const later = () => new Date(Date.now() + 3_600_000);

  function scheduled(key: string) {
    const { userId: _userId, idempotencyKey: _key, ...message } = reply(key);
    return { ...message, idempotencyKey: key, scheduledAt: later() };
  }

  it('files once when Schedule is pressed twice', async () => {
    const key = `schedule:${unique()}`;
    const gate = await holdSentFiling();
    try {
      const first = emailService.scheduleMessage(user.id, scheduled(key));
      await waitFor(async () => (await lockWaiters()) >= 1);
      const second = emailService.scheduleMessage(user.id, scheduled(key));
      await waitFor(async () => (await lockWaiters()) >= 2);
      await gate.release();

      const [a, b] = await Promise.all([first, second]);
      expect(b.id).toBe(a.id);
      expect(await sentRows(a.messageId)).toHaveLength(1);
    } finally {
      await gate.release();
    }
  });

  it('files and sends once when Schedule races Send now, and goes out when due', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const gate = await holdSentFiling();
    let row: { id: string; messageId: string };
    try {
      const schedule = emailService.scheduleMessage(user.id, scheduled(key));
      await waitFor(async () => (await lockWaiters()) >= 1);
      const sendNow = acceptOutboundMessage(reply(key));
      await waitFor(async () => (await lockWaiters()) >= 2);
      await gate.release();

      row = await schedule;
      const answered = await sendNow;
      expect(answered.messageRowId).toBe(row.id);
      // It is scheduled, not being delivered.
      expect(answered.delivery).toBeNull();
      expect(await sentRows(row.messageId)).toHaveLength(1);
      expect(await deliveryOf(row.id)).toBeUndefined();
    } finally {
      await gate.release();
    }

    await getDb()
      .update(messages)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(messages.id, row.id));
    await emailService.processScheduledMessages();
    await emailService.processScheduledMessages();
    expect(relayCallsFor(row.messageId)).toHaveLength(1);
    expect(await deliveryOf(row.id)).toMatchObject({ state: 'sent' });
    // And a repeat of the key now reports the delivery.
    expect((await acceptOutboundMessage(reply(key))).delivery?.state).toBe('sent');
  });

  /** Make a scheduled message due now. */
  async function due(rowId: string) {
    await getDb()
      .update(messages)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(messages.id, rowId));
  }

  async function claimOf(key: string) {
    const [claim] = await getDb()
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, user.id), eq(emailOutbox.idempotencyKey, key)));
    return claim;
  }

  it('is not an outbox delivery: never listed, cancelled or retried there', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    const claim = await claimOf(key);

    expect((await listEmailOutbox(user.id, 100)).map((d) => d.id)).not.toContain(claim.id);
    await expect(cancelEmailOutbox(user.id, claim.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(retryEmailOutbox(user.id, claim.id)).rejects.toMatchObject({ statusCode: 404 });
    // The worker never takes it either; it goes out when due, once.
    await processEmailOutbox();
    expect(relayCallsFor(row.messageId)).toHaveLength(0);
    await due(row.id);
    await emailService.processScheduledMessages();
    expect(relayCallsFor(row.messageId)).toHaveLength(1);
    // Now it is the message's delivery, and an ordinary one.
    expect((await listEmailOutbox(user.id, 100)).map((d) => d.id)).toContain(claim.id);
  });

  /** A scheduled message is cancelled the moment it leaves Sent, and says so. */
  async function expectCancelled(row: { id: string; messageId: string }, key?: string) {
    const [stored] = await getDb()
      .select({ scheduledAt: messages.scheduledAt })
      .from(messages)
      .where(eq(messages.id, row.id));
    expect(stored.scheduledAt).toBeNull();
    expect(await deliveryOf(row.id)).toMatchObject({ state: 'failed', errorCode: 'cancelled' });
    if (key) {
      expect(await claimOf(key)).toMatchObject({ status: 'cancelled', messageRowId: row.id });
      // Every repeat of its key is refused, whatever it carries.
      await expect(acceptOutboundMessage(reply(key))).rejects.toMatchObject({
        statusCode: 422,
        details: { id: row.id, deliveryState: 'cancelled', scheduledAt: null },
      });
    }
    // Nothing sends it: not the due job, not the worker, not after a restore.
    const sent = await emailService.getMailboxBySpecialUse(user.id, '\\Sent');
    if (!sent) throw new Error('no Sent mailbox');
    await emailService.moveMessage(user.id, row.id, sent.id);
    await emailService.processScheduledMessages();
    await processEmailOutbox();
    expect(relayCallsFor(row.messageId)).toHaveLength(0);
    // Nor can it be retried from the message.
    await expect(retryMessageDelivery(user.id, row.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  }

  it.each([
    ['under a key', (key: string) => scheduled(key), true],
    ['without a key', (key: string) => ({ ...scheduled(key), idempotencyKey: undefined }), false],
  ])('moved to Trash is cancelled there and then (%s)', async (_case, build, keyed) => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, build(key));
    await emailService.deleteMessage(user.id, row.id);
    await expectCancelled(row, keyed ? key : undefined);
  });

  it('moved to a folder, in bulk, or snoozed is cancelled the same way', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const folder = await emailService.createMailbox(user.id, `Folder ${unique().slice(0, 8)}`);
    const trash = await emailService.getMailboxBySpecialUse(user.id, '\\Trash');
    if (!trash) throw new Error('no Trash');

    const moved = `schedule:${unique()}`;
    const toFolder = await emailService.scheduleMessage(user.id, scheduled(moved));
    await emailService.moveMessage(user.id, toFolder.id, folder.id);
    await expectCancelled(toFolder, moved);

    const bulk = `schedule:${unique()}`;
    const inBulk = await emailService.scheduleMessage(user.id, scheduled(bulk));
    await emailService.bulkMoveMessages(user.id, [inBulk.id], trash.id);
    await expectCancelled(inBulk, bulk);

    const snoozed = `schedule:${unique()}`;
    const asleep = await emailService.scheduleMessage(user.id, scheduled(snoozed));
    await emailService.snoozeMessage(user.id, asleep.id, new Date(Date.now() + 86_400_000));
    await expectCancelled(asleep, snoozed);
  });

  it('in a folder that is deleted is cancelled with the folder`s mail', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    const folder = await emailService.createMailbox(user.id, `Folder ${unique().slice(0, 8)}`);
    // Filed there while still scheduled — as a message moved before moves
    // cancelled one was left.
    await getDb().update(messages).set({ mailboxId: folder.id }).where(eq(messages.id, row.id));

    await emailService.deleteMailbox(user.id, folder.id);
    await expectCancelled(row, key);
  });

  it('found out of Sent by the due job is cancelled there, linked, and never sent', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    const trash = await emailService.getMailboxBySpecialUse(user.id, '\\Trash');
    if (!trash) throw new Error('no Trash');
    // Moved by a path that does not unschedule (or before moves did).
    await getDb().update(messages).set({ mailboxId: trash.id }).where(eq(messages.id, row.id));
    await due(row.id);

    await emailService.processScheduledMessages();
    expect(await claimOf(key)).toMatchObject({ status: 'cancelled', messageRowId: row.id });
    expect(await deliveryOf(row.id)).toMatchObject({ state: 'failed', errorCode: 'cancelled' });
    expect(deliveryEvents(row.id).length).toBeGreaterThanOrEqual(1);
    await expectCancelled(row, key);
  });

  it('moved while the due job is sending it is left sent, not marked cancelled', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    const claim = await claimOf(key);
    await due(row.id);
    const trash = await emailService.getMailboxBySpecialUse(user.id, '\\Trash');
    if (!trash) throw new Error('no Trash');

    // The due job takes the message off the schedule, then waits on its claim.
    const gate = holdLock((tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.id, claim.id)).for('update'),
    );
    await gate.held;
    try {
      const dueJob = emailService.processScheduledMessages();
      await waitFor(async () => (await lockWaiters()) >= 1);
      // The move read it as scheduled, and now waits on the due job's row lock.
      const move = emailService.moveMessage(user.id, row.id, trash.id);
      await waitFor(async () => (await lockWaiters()) >= 2);
      await gate.release();
      await Promise.all([dueJob, move]);
    } finally {
      await gate.release();
    }

    expect(relayCallsFor(row.messageId)).toHaveLength(1);
    expect(await deliveryOf(row.id)).toMatchObject({ state: 'sent' });
    expect(await claimOf(key)).toMatchObject({ status: 'sent' });
  });

  it('from a blocked sender moved to Junk is cancelled like any other move', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    // A user of its own: blocking a sender is account-wide.
    const username = `blocker${unique().slice(0, 10)}`;
    const [owner] = await getDb()
      .insert(users)
      .values({ username, color: 'teal' })
      .returning({ id: users.id });
    await emailService.ensureMailboxes(owner.id);
    const address = `${username}@oxy.so`;
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(owner.id, {
      from: { name: '', address },
      to: [{ name: '', address: `blocked-${unique().slice(0, 8)}@example.com` }],
      subject: 'Later',
      text: 'Hi',
      idempotencyKey: key,
      scheduledAt: later(),
    });

    await emailService.unsubscribe(owner.id, address, 'block');
    const [stored] = await getDb()
      .select({ scheduledAt: messages.scheduledAt })
      .from(messages)
      .where(eq(messages.id, row.id));
    expect(stored.scheduledAt).toBeNull();
    const [held] = await getDb()
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, owner.id), eq(emailOutbox.idempotencyKey, key)));
    expect(held).toMatchObject({ status: 'cancelled', messageRowId: row.id });
    expect((await emailService.getMessage(owner.id, row.id))?.delivery).toMatchObject({
      errorCode: 'cancelled',
    });
  });

  it('scheduled before claims, then unscheduled, reads as cancelled, and says so on retry', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    // As a message scheduled before scheduled sends took claims.
    await getDb()
      .delete(emailOutbox)
      .where(and(eq(emailOutbox.userId, user.id), eq(emailOutbox.idempotencyKey, key)));
    await emailService.deleteMessage(user.id, row.id);

    await expect(
      acceptOutboundMessage({ ...reply(key), text: 'Something else entirely' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: { id: row.id, deliveryState: 'cancelled' },
    });
    await expect(retryMessageDelivery(user.id, row.id)).rejects.toThrow(
      /cancelled before it was sent/,
    );
    expect(relayCallsFor(row.messageId)).toHaveLength(0);
  });

  it('deleted for good cancels its claim: a repeat of its key is refused, never 202', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `schedule:${unique()}`;
    const row = await emailService.scheduleMessage(user.id, scheduled(key));
    await emailService.deleteMessage(user.id, row.id, true);
    expect(await claimOf(key)).toMatchObject({ status: 'cancelled' });

    const refusal = {
      statusCode: 422,
      details: {
        reason: 'idempotency_key_reused',
        id: null,
        messageId: row.messageId,
        deliveryState: 'cancelled',
        scheduledAt: null,
      },
    };
    await expect(acceptOutboundMessage(reply(key))).rejects.toMatchObject(refusal);
    await expect(
      acceptOutboundMessage({ ...reply(key), text: 'Something else entirely' }),
    ).rejects.toMatchObject(refusal);
    await expect(emailService.scheduleMessage(user.id, scheduled(key))).rejects.toMatchObject(
      refusal,
    );
    expect(relayCallsFor(row.messageId)).toHaveLength(0);
  });
});

describe('a refused repeat says where the first send stands', () => {
  const other = { text: 'Something else entirely' };

  it('scheduled, with when', async () => {
    const key = `schedule:${unique()}`;
    const at = new Date(Date.now() + 7_200_000);
    const { userId: _userId, ...message } = reply(key);
    const row = await emailService.scheduleMessage(user.id, { ...message, scheduledAt: at });
    await expect(acceptOutboundMessage({ ...reply(key), ...other })).rejects.toMatchObject({
      details: { id: row.id, deliveryState: 'scheduled', scheduledAt: at.toISOString() },
    });
  });

  it('sent', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `k:${unique()}`;
    const { rowId } = await accept(reply(key));
    await settled(rowId, 'sent');
    await expect(acceptOutboundMessage({ ...reply(key), ...other })).rejects.toMatchObject({
      details: { id: rowId, deliveryState: 'sent', scheduledAt: null },
    });
  });

  it('failed for good', async () => {
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('554 5.7.1 Message rejected'), { responseCode: 554 }),
    );
    const key = `k:${unique()}`;
    const { rowId } = await accept(reply(key));
    await settled(rowId, 'failed');
    await expect(acceptOutboundMessage({ ...reply(key), ...other })).rejects.toMatchObject({
      details: { id: rowId, deliveryState: 'failed' },
    });
  });
});

describe('a reply retried under its key', () => {
  /** A received message the user holds, to reply to. */
  async function parent(messageId: string, references: string[], createdAt = new Date()) {
    const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
    if (!inbox) throw new Error('no Inbox');
    const [row] = await getDb()
      .insert(messages)
      .values({
        userId: user.id,
        mailboxId: inbox.id,
        messageId,
        fromAddress: 'support@example.com',
        subject: 'Quota Increase',
        size: 10,
        references,
        date: createdAt,
        receivedAt: createdAt,
        createdAt,
      })
      .returning({ id: messages.id });
    return row.id;
  }

  const command = (inReplyTo: string) => ({
    to: [{ name: '', address: 'support@example.com' }],
    subject: 'Re: Quota Increase',
    text: 'Thanks',
    inReplyTo,
  });

  it('is answered after the parent it threads under changed or went away', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const key = `reply:${unique()}`;
    const parentId = `<parent-${unique()}@example.com>`;
    const row = await parent(parentId, [`<root-${unique()}@example.com>`]);

    const first = await sendMessageForUser(user.id, command(parentId), key);

    // The parent's own References change (it was re-filed), then it is deleted.
    await getDb()
      .update(messages)
      .set({ references: [`<other-${unique()}@example.com>`] })
      .where(eq(messages.id, row));
    const changed = await sendMessageForUser(user.id, command(parentId), key);
    expect(changed.data.id).toBe(first.data.id);

    await getDb().delete(messages).where(eq(messages.id, row));
    const gone = await sendMessageForUser(user.id, command(parentId), key);
    expect(gone.data.id).toBe(first.data.id);

    await settled(first.data.id as string, 'sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('threads under the earliest copy of a parent held twice', async () => {
    mockSendMail.mockResolvedValue({ response: '250 Ok' });
    const parentId = `<twice-${unique()}@example.com>`;
    const original = `<original-root-${unique()}@example.com>`;
    // The later copy is inserted first, so it is first in the index too.
    await parent(parentId, [`<later-root-${unique()}@example.com>`]);
    await parent(parentId, [original], new Date(Date.now() - 3_600_000));

    const sent = await sendMessageForUser(user.id, command(parentId), `reply:${unique()}`);
    await settled(sent.data.id as string, 'sent');
    const [row] = await getDb()
      .select({ references: messages.references })
      .from(messages)
      .where(eq(messages.id, sent.data.id as string));
    expect(row.references).toEqual([original, parentId]);
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
