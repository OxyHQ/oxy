/**
 * What one inbound delivery does side by side, and what it announces, against
 * a REAL Postgres. The asset service is stubbed (it owns S3); the socket layer
 * is captured, so the emits asserted are the ones a client would receive.
 *
 *  - Attachments upload concurrently, yet the stored message lists them in
 *    the order the sender attached them, whatever order the uploads finish.
 *  - A failed upload is cleaned up only after the uploads already running
 *    have finished: a file created a moment after the failure is a file the
 *    cleanup must still see.
 *  - The user's filters write without announcing; the delivery then sends ONE
 *    `email:changed` naming every folder the rules touched.
 */

const mockGetIO = jest.fn();
const mockUploadFileDirect = jest.fn();
const mockLinkFile = jest.fn();
const mockDeleteFile = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: (...args: unknown[]) => mockGetIO(...args),
}));
jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    linkFile: (...args: unknown[]) => mockLinkFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  },
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
jest.mock('../smtp.outbound', () => ({
  __esModule: true,
  smtpOutbound: { send: jest.fn() },
  default: { send: jest.fn() },
}));
jest.mock('../emailPushDelivery.service', () => ({
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService, type FilterActionInput } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function recipient(): Promise<{ id: string; username: string }> {
  const username = `dlv${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return { id: row.id, username };
}

/** A real `files` row, so the attachment foreign key has something to point at. */
async function storedFile(ownerUserId: string, name: string) {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: unique(),
      size: 100,
      mime: 'application/pdf',
      ext: 'pdf',
      storageKey: `assets/${unique()}`,
      originalName: name,
      ownerUserId,
    })
    .returning({ id: files.id });
  return { id: row.id, originalName: name, mime: 'application/pdf', size: 100 };
}

const attachment = (name: string) => ({
  filename: name,
  contentType: 'application/pdf',
  content: Buffer.from(`${name}-${unique()}`),
});

function deliver(
  username: string,
  overrides: { subject?: string; attachments?: ReturnType<typeof attachment>[] } = {},
) {
  return emailService.storeIncomingMessage({
    recipientUsername: username,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject: overrides.subject ?? 'Hello',
    text: 'Body',
    messageId: `<${unique()}@example.com>`,
    date: new Date(),
    headers: {},
    attachments: overrides.attachments,
    rawSize: 100,
  });
}

/** A call the test settles by hand, so the interleaving is the test's to choose. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait until `condition` holds, polling; fails loudly instead of hanging. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Route every socket emit into one list, as `{ event, payload }` pairs in order. */
function captureEmits(): Array<{ event: string; payload: unknown }> {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  mockGetIO.mockReturnValue({
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  });
  return emitted;
}

async function folderOf(userId: string, specialUse: string): Promise<string> {
  await emailService.ensureMailboxes(userId);
  const box = await emailService.getMailboxBySpecialUse(userId, specialUse);
  if (!box) throw new Error(`no ${specialUse}`);
  return box.id;
}

/** One rule: subject contains "rule", then `actions`. */
async function rule(userId: string, actions: FilterActionInput[]): Promise<void> {
  await emailService.createFilter(userId, {
    name: `Rule-${unique()}`,
    enabled: true,
    matchAll: true,
    order: 0,
    conditions: [{ field: 'subject', operator: 'contains', value: 'rule' }],
    actions,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetIO.mockReturnValue(null);
  mockLinkFile.mockResolvedValue(undefined);
  mockDeleteFile.mockResolvedValue(undefined);
});

describe('attachments upload side by side', () => {
  it('keeps the sender`s order when the uploads finish in reverse', async () => {
    const user = await recipient();
    const stored = await Promise.all(
      ['a.pdf', 'b.pdf', 'c.pdf'].map((n) => storedFile(user.id, n)),
    );
    const uploads = stored.map(() => deferred<(typeof stored)[number]>());
    mockUploadFileDirect.mockImplementation(
      (_user: string, _content: Buffer, _type: string, name: string) =>
        uploads[['a.pdf', 'b.pdf', 'c.pdf'].indexOf(name)].promise,
    );

    const delivery = deliver(user.username, {
      attachments: [attachment('a.pdf'), attachment('b.pdf'), attachment('c.pdf')],
    });
    // All three are in flight at once.
    await until(() => mockUploadFileDirect.mock.calls.length === 3, 'three uploads');
    uploads[2].resolve(stored[2]);
    uploads[1].resolve(stored[1]);
    uploads[0].resolve(stored[0]);
    const dto = await delivery;

    expect(dto.attachments.map((a) => a.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    // Linked once each, to the stored row.
    expect(mockLinkFile.mock.calls.map(([fileId]) => fileId).sort()).toEqual(
      stored.map((f) => f.id).sort(),
    );
  });

  it('cleans up a file that finished uploading after another upload had failed', async () => {
    const user = await recipient();
    const first = await storedFile(user.id, 'first.pdf');
    const late = deferred<typeof first>();
    mockUploadFileDirect
      .mockImplementationOnce(() => late.promise)
      .mockImplementationOnce(() => Promise.reject(new Error('S3 unavailable')));

    const delivery = deliver(user.username, {
      attachments: [attachment('first.pdf'), attachment('second.pdf')],
    });
    delivery.catch(() => undefined);
    await until(() => mockUploadFileDirect.mock.calls.length === 2, 'both uploads');
    // The second upload has failed; the first is still running. The delivery
    // must not answer, nor clean up, before it lands.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockDeleteFile).not.toHaveBeenCalled();
    late.resolve(first);

    await expect(delivery).rejects.toThrow('S3 unavailable');
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(first.id, false, user.id);
    expect(
      await getDb()
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.userId, user.id), eq(messages.subject, 'Hello'))),
    ).toEqual([]);
  });
});

describe('filters announce once, naming every folder they touched', () => {
  it('a rule that labels and files the message: one event, both folders recounted', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    const receipts = await emailService.createMailbox(user.id, `Receipts-${unique()}`);
    const label = await emailService.createLabel(user.id, `L${unique().slice(0, 8)}`, '#123456');
    await rule(user.id, [
      { type: 'label', value: label.name },
      { type: 'move', value: receipts.id },
    ]);

    const emitted = captureEmits();
    const dto = await deliver(user.username, { subject: 'matches the rule' });

    expect(dto.mailboxId).toBe(receipts.id);
    expect(dto.labels).toEqual([label.name]);
    expect(emitted).toEqual([
      {
        event: 'email:changed',
        payload: { id: dto.id, mailboxIds: [inbox, receipts.id], reason: 'moved' },
      },
      // The welcome message provisioning filed is still unread in the Inbox.
      { event: 'email:unread_count', payload: { mailboxId: inbox, unread: 1 } },
      { event: 'email:unread_count', payload: { mailboxId: receipts.id, unread: 1 } },
    ]);
  });

  it('names a folder a later rule moved the message on from', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    const archive = await folderOf(user.id, '\\Archive');
    const staging = await emailService.createMailbox(user.id, `Staging-${unique()}`);
    await rule(user.id, [{ type: 'move', value: staging.id }, { type: 'archive' }]);

    const emitted = captureEmits();
    const dto = await deliver(user.username, { subject: 'matches the rule' });

    expect(dto.mailboxId).toBe(archive);
    expect(emitted.filter((e) => e.event === 'email:changed')).toEqual([
      {
        event: 'email:changed',
        payload: { id: dto.id, mailboxIds: [inbox, staging.id, archive], reason: 'moved' },
      },
    ]);
  });

  it('a rule that only labels leaves the message new: announced as new mail, nothing else', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    const label = await emailService.createLabel(user.id, `L${unique().slice(0, 8)}`, '#654321');
    await rule(user.id, [{ type: 'label', value: label.name }]);

    const emitted = captureEmits();
    const dto = await deliver(user.username, { subject: 'matches the rule' });

    expect(dto.labels).toEqual([label.name]);
    expect(emitted.map((e) => e.event)).toEqual(['email:new', 'email:unread_count']);
    expect(emitted[1].payload).toEqual({ mailboxId: inbox, unread: 2 });
  });
});
