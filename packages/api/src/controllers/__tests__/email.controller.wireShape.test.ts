/**
 * What `GET /email/messages`, `GET /email/messages/:id` and `GET /email/mailboxes`
 * put on the wire, on a REAL Postgres with the REAL sender-avatar service. Only
 * the network under the avatar lookup is faked: DNS and `fetch` fail, as an
 * unknown sender's lookups do.
 *
 * These are exact: the key order of `pagination` (it is the JSON's byte
 * order), the full key set of a message, the avatar each kind of sender gets,
 * the thread fields, and which error wins when two would apply. Making these
 * reads cheaper must not move any of it.
 */

const mockResolveTxt = jest.fn();

jest.mock('dns/promises', () => ({
  __esModule: true,
  default: { resolveTxt: (...args: unknown[]) => mockResolveTxt(...args) },
  resolveTxt: (...args: unknown[]) => mockResolveTxt(...args),
}));
jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { uploadFileDirect: jest.fn(), linkFile: jest.fn(), getFilesByIds: jest.fn() },
}));
jest.mock('../../services/aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn().mockReturnValue(true) },
}));
jest.mock('../../services/cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/emailPushDelivery.service', () => ({
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_MAILBOXES } from '../../config/email.config';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { senderAvatars } from '../../db/schema/senderAvatars';
import { users } from '../../db/schema/users';
import { emailService } from '../../services/email.service';
import { settleAvatarResolutions } from '../../services/senderAvatar.service';
import { getMessage, listMailboxes, listMessages } from '../email.controller';

const unique = () => randomUUID().replace(/-/g, '');

/** Every key a listed message carries, in the order the DTO builds them. */
const LISTED_MESSAGE_KEYS = [
  '_id',
  'id',
  'threadId',
  'userId',
  'mailboxId',
  'messageId',
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'attachments',
  'flags',
  'labels',
  'highlights',
  'encrypted',
  'spamScore',
  'spamAction',
  'size',
  'inReplyTo',
  'references',
  'aliasTag',
  'snoozedUntil',
  'snoozedFromMailbox',
  'scheduledAt',
  'draftRevision',
  'readReceiptRequested',
  'readReceiptSent',
  'date',
  'receivedAt',
  'createdAt',
  'updatedAt',
  'threadCount',
  'threadParticipants',
  'senderAvatarPath',
];

type Handler = (req: never, res: Response) => Promise<void>;

/** Call a handler and return the JSON it answered with, as it reaches the wire. */
async function wire(
  handler: Handler,
  req: { userId: string; query?: Record<string, string>; params?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const res = { json: jest.fn().mockReturnThis() };
  await handler(
    { user: { id: req.userId }, query: req.query ?? {}, params: req.params ?? {} } as never,
    res as unknown as Response,
  );
  expect(res.json).toHaveBeenCalledTimes(1);
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0])) as Record<string, unknown>;
}

async function newUser(values: { username?: string; avatar?: string } = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...values })
    .returning({ id: users.id });
  return row.id;
}

let owner: string;
let folder: string;
let oxySender: { address: string; avatar: string };
let cachedSender: string;
let unknownSender: string;
let root: { id: string; messageId: string };
let reply: { id: string };
let stranger: { id: string };

async function store(values: {
  fromAddress: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
}): Promise<{ id: string; messageId: string }> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId: owner,
      mailboxId: folder,
      messageId: `<${unique()}@example.com>`,
      fromName: 'Sender',
      subject: 'Pinned',
      text: 'body',
      size: 4,
      ...values,
    })
    .returning({ id: messages.id, messageId: messages.messageId });
  return row;
}

let fetchMock: jest.Mock;

beforeAll(async () => {
  await connectPostgres();
  owner = await newUser({ username: `owner${unique().slice(0, 10)}` });
  folder = (await emailService.createMailbox(owner, `Pins${unique().slice(0, 6)}`)).id;

  const oxyUsername = `oxysender${unique().slice(0, 10)}`;
  oxySender = { address: `${oxyUsername}@oxy.so`, avatar: unique() };
  await newUser({ username: oxyUsername, avatar: oxySender.avatar });

  cachedSender = `cached${unique().slice(0, 8)}@example.com`;
  await getDb()
    .insert(senderAvatars)
    .values({
      email: cachedSender,
      avatarPath: '/pinned-avatar',
      source: 'gravatar',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
  unknownSender = `nobody@u${unique().slice(0, 10)}.example`;

  // Oldest first; the list is newest first.
  root = await store({ fromAddress: oxySender.address, date: new Date('2026-01-01T00:00:00Z') });
  reply = await store({
    fromAddress: cachedSender,
    date: new Date('2026-01-02T00:00:00Z'),
    inReplyTo: root.messageId,
    references: [root.messageId],
  });
  stranger = await store({ fromAddress: unknownSender, date: new Date('2026-01-03T00:00:00Z') });
});

afterAll(async () => {
  // A sender the reads did not know is looked up in the background.
  await settleAvatarResolutions();
  await closePostgres();
});

beforeEach(() => {
  mockResolveTxt.mockRejectedValue(new Error('no bimi'));
  fetchMock = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('GET /email/messages — the wire shape', () => {
  it('answers offset paging with exactly total, limit, offset, hasMore', async () => {
    const body = await wire(listMessages, {
      userId: owner,
      query: { mailbox: folder, limit: '2' },
    });

    expect(Object.keys(body)).toEqual(['data', 'pagination']);
    expect(Object.keys(body.pagination as object)).toEqual(['total', 'limit', 'offset', 'hasMore']);
    expect(body.pagination).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true });

    const data = body.data as Array<Record<string, unknown>>;
    expect(data.map((m) => m.id)).toEqual([stranger.id, reply.id]);
    // The stranger has no thread, so no count; the key set is otherwise the same.
    expect(Object.keys(data[1])).toEqual(LISTED_MESSAGE_KEYS);
    expect(Object.keys(data[0])).toEqual(
      LISTED_MESSAGE_KEYS.filter((k) => k !== 'threadCount' && k !== 'threadParticipants'),
    );

    const last = await wire(listMessages, {
      userId: owner,
      query: { mailbox: folder, limit: '2', offset: '2' },
    });
    expect(last.pagination).toEqual({ total: 3, limit: 2, offset: 2, hasMore: false });
    expect((last.data as Array<{ id: string }>).map((m) => m.id)).toEqual([root.id]);
  });

  it('answers cursor paging with exactly total, limit, offset, hasMore, nextCursor', async () => {
    const first = await wire(listMessages, {
      userId: owner,
      query: { mailbox: folder, limit: '2', cursor: '' },
    });

    expect(Object.keys(first.pagination as object)).toEqual([
      'total',
      'limit',
      'offset',
      'hasMore',
      'nextCursor',
    ]);
    const pagination = first.pagination as { nextCursor: string };
    expect(pagination).toEqual({
      total: 3,
      limit: 2,
      offset: 0,
      hasMore: true,
      nextCursor: expect.any(String),
    });

    const second = await wire(listMessages, {
      userId: owner,
      query: { mailbox: folder, limit: '2', offset: '7', cursor: pagination.nextCursor },
    });
    // `offset` reads 0 in cursor mode whatever was asked, and `total` is the
    // whole folder, not what is left.
    expect(second.pagination).toEqual({
      total: 3,
      limit: 2,
      offset: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect((second.data as Array<{ id: string }>).map((m) => m.id)).toEqual([root.id]);
  });

  it('gives each kind of sender its avatar, and the thread its count and id', async () => {
    const body = await wire(listMessages, { userId: owner, query: { mailbox: folder } });
    const byId = new Map((body.data as Array<Record<string, unknown>>).map((m) => [m.id, m]));

    // An Oxy account: its own avatar, without any outbound request.
    expect(byId.get(root.id)?.senderAvatarPath).toBe(`/api/assets/${oxySender.avatar}/stream`);
    // A cached sender: the cached path.
    expect(byId.get(reply.id)?.senderAvatarPath).toBe('/pinned-avatar');
    // A sender nothing is known about yet: the key is there, and null.
    expect(byId.get(stranger.id)).toHaveProperty('senderAvatarPath', null);

    // The reply carries the headers, so the walk starts from it: the whole
    // thread's count and participants, and the thread's stable (smallest) id.
    expect(byId.get(reply.id)).toMatchObject({
      threadId: root.id,
      threadCount: 2,
      threadParticipants: expect.arrayContaining([oxySender.address, cachedSender]),
    });
    expect(byId.get(reply.id)?.threadParticipants).toHaveLength(2);
    // The root has no threading headers of its own: its own id, and no count.
    expect(byId.get(root.id)?.threadId).toBe(root.id);
    expect(byId.get(root.id)).not.toHaveProperty('threadCount');
    expect(byId.get(stranger.id)?.threadId).toBe(stranger.id);
  });

  it('answers a folder that is not the caller`s with 404 before reading a bad cursor', async () => {
    const other = await newUser();
    const theirs = (await emailService.createMailbox(other, 'Theirs')).id;
    const res = { json: jest.fn() };

    await expect(
      listMessages(
        { user: { id: owner }, query: { mailbox: theirs, cursor: 'not-a-cursor' } } as never,
        res as unknown as Response,
      ),
    ).rejects.toMatchObject({ name: 'NotFoundError', message: 'Mailbox not found' });
    await expect(
      listMessages(
        { user: { id: owner }, query: { mailbox: theirs } } as never,
        res as unknown as Response,
      ),
    ).rejects.toMatchObject({ name: 'NotFoundError', message: 'Mailbox not found' });
    expect(res.json).not.toHaveBeenCalled();
  });

  it('answers a bad cursor on the caller`s own folder with 400', async () => {
    await expect(
      listMessages(
        { user: { id: owner }, query: { mailbox: folder, cursor: 'not-a-cursor' } } as never,
        { json: jest.fn() } as unknown as Response,
      ),
    ).rejects.toMatchObject({ name: 'BadRequestError' });
  });
});

describe('GET /email/messages/:id — the wire shape', () => {
  it('answers the message with its body, thread fields and avatar', async () => {
    const body = await wire(getMessage, { userId: owner, params: { messageId: reply.id } });

    expect(Object.keys(body)).toEqual(['data']);
    const data = body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      id: reply.id,
      text: 'body',
      threadId: root.id,
      threadCount: 2,
      senderAvatarPath: '/pinned-avatar',
    });
    expect(Object.keys(data).sort()).toEqual(
      [...LISTED_MESSAGE_KEYS, 'text', 'html', 'headers'].sort(),
    );
  });
});

describe('GET /email/mailboxes — the wire shape', () => {
  it('provisions a new user once, and then answers the same array', async () => {
    const userId = await newUser({ username: `fresh${unique().slice(0, 10)}` });

    const first = await wire(listMailboxes, { userId });
    const second = await wire(listMailboxes, { userId });

    expect(Object.keys(first)).toEqual(['data']);
    const data = first.data as Array<{ path: string; specialUse: string; totalMessages: number }>;
    expect(data.map((m) => m.path)).toEqual(DEFAULT_MAILBOXES.map((m) => m.path).sort());
    // The welcome message, written by the provisioning, counted in the Inbox.
    expect(data.find((m) => m.specialUse === '\\Inbox')?.totalMessages).toBe(1);
    expect(second).toEqual(first);
  });

  it('answers a provisioned user without checking the provisioning again', async () => {
    const userId = await newUser({ username: `steady${unique().slice(0, 10)}` });
    const ensure = jest.spyOn(emailService, 'ensureMailboxes');

    try {
      await wire(listMailboxes, { userId });
      expect(ensure).toHaveBeenCalledTimes(1);
      await wire(listMailboxes, { userId });
      expect(ensure).toHaveBeenCalledTimes(1);
    } finally {
      ensure.mockRestore();
    }
  });

  it('restores a default folder a provisioned user is missing', async () => {
    const userId = await newUser({ username: `partial${unique().slice(0, 10)}` });
    await wire(listMailboxes, { userId });
    await getDb()
      .delete(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.specialUse, '\\Archive')));

    const body = await wire(listMailboxes, { userId });

    const data = body.data as Array<{ path: string; specialUse: string; totalMessages: number }>;
    expect(data.map((m) => m.path)).toEqual(DEFAULT_MAILBOXES.map((m) => m.path).sort());
    // Restoring a folder is not a second provisioning: still one welcome.
    expect(data.find((m) => m.specialUse === '\\Inbox')?.totalMessages).toBe(1);
  });
});
