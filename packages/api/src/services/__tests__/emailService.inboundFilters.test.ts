/**
 * Inbound delivery runs the user's filters BEFORE it announces the message,
 * against a REAL Postgres.
 *
 * The filters used to be fire-and-forget, racing the push and `email:new`. A
 * rule that archived, filed, deleted or marked a message read therefore still
 * buzzed the phone and toasted on every open client — for mail the user had
 * explicitly asked never to be bothered by. Every case below states BOTH sides:
 * what was (not) announced, and where the message actually ended up, so a test
 * cannot pass because nothing ran at all.
 */

const mockSendInboxEmailPush = jest.fn();
const mockEmitEmailNew = jest.fn();
const mockEmitEmailChanged = jest.fn();

jest.mock('../inboxRealtime', () => ({
  ...jest.requireActual('../inboxRealtime'),
  emitEmailNew: (...args: unknown[]) => mockEmitEmailNew(...args),
  emitEmailChanged: (...args: unknown[]) => mockEmitEmailChanged(...args),
}));
jest.mock('../emailPushDelivery.service', () => ({
  sendInboxEmailPush: (...args: unknown[]) => mockSendInboxEmailPush(...args),
}));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));
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

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService, type FilterActionInput } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function recipient(): Promise<{ id: string; username: string }> {
  const username = `flt${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return { id: row.id, username };
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

function deliver(username: string, subject = 'matches the rule') {
  return emailService.storeIncomingMessage({
    recipientUsername: username,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject,
    text: 'Body',
    messageId: `<flt-${unique()}@example.com>`,
    date: new Date('2026-01-01T00:00:00.000Z'),
    headers: {},
    rawSize: 100,
  });
}

async function stateOf(id: string) {
  const [row] = await getDb()
    .select({ mailboxId: messages.mailboxId, seen: messages.seen, labels: messages.labels })
    .from(messages)
    .where(eq(messages.id, id));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockSendInboxEmailPush.mockReset();
  mockEmitEmailNew.mockReset();
  mockEmitEmailChanged.mockReset();
});

describe('storeIncomingMessage — filters decide whether the user is notified', () => {
  it('notifies for mail no rule touched', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');

    const stored = await deliver(user.username, 'nothing matches');

    expect(stored.mailboxId).toBe(inbox);
    expect(mockSendInboxEmailPush).toHaveBeenCalledTimes(1);
    expect(mockEmitEmailNew).toHaveBeenCalledWith(
      expect.objectContaining({ id: stored.id, mailboxId: inbox }),
    );
  });

  it('does not notify for mail a rule moved out of the Inbox', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    const target = await emailService.createMailbox(user.id, `Filed-${unique()}`);
    await rule(user.id, [{ type: 'move', value: target.id }]);

    const stored = await deliver(user.username);

    expect((await stateOf(stored.id)).mailboxId).toBe(target.id);
    expect(stored.mailboxId).toBe(target.id);
    expect(mockSendInboxEmailPush).not.toHaveBeenCalled();
    expect(mockEmitEmailNew).not.toHaveBeenCalled();
    // Lists still hear about it — both the delivery folder and the target.
    expect(mockEmitEmailChanged).toHaveBeenLastCalledWith({
      userId: user.id,
      id: stored.id,
      mailboxIds: [inbox, target.id],
      reason: 'moved',
    });
  });

  it('does not notify for mail a rule archived', async () => {
    const user = await recipient();
    const archive = await folderOf(user.id, '\\Archive');
    await rule(user.id, [{ type: 'archive' }]);

    const stored = await deliver(user.username);

    expect((await stateOf(stored.id)).mailboxId).toBe(archive);
    expect(mockSendInboxEmailPush).not.toHaveBeenCalled();
    expect(mockEmitEmailNew).not.toHaveBeenCalled();
  });

  it('does not notify for mail a rule deleted', async () => {
    const user = await recipient();
    const trash = await folderOf(user.id, '\\Trash');
    await rule(user.id, [{ type: 'delete' }]);

    const stored = await deliver(user.username);

    expect((await stateOf(stored.id)).mailboxId).toBe(trash);
    expect(mockSendInboxEmailPush).not.toHaveBeenCalled();
    expect(mockEmitEmailNew).not.toHaveBeenCalled();
  });

  it('does not notify for mail a rule marked read, but still tells lists it changed', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    await rule(user.id, [{ type: 'mark-read' }]);

    const stored = await deliver(user.username);

    expect(await stateOf(stored.id)).toMatchObject({ mailboxId: inbox, seen: true });
    expect(stored.flags.seen).toBe(true);
    expect(mockSendInboxEmailPush).not.toHaveBeenCalled();
    expect(mockEmitEmailNew).not.toHaveBeenCalled();
    expect(mockEmitEmailChanged).toHaveBeenLastCalledWith({
      userId: user.id,
      id: stored.id,
      mailboxIds: [inbox],
      reason: 'flags',
    });
  });

  it('still notifies for mail a rule only labelled or starred, and returns it labelled', async () => {
    const user = await recipient();
    await emailService.createLabel(user.id, 'Flagged', '#000000');
    await rule(user.id, [{ type: 'label', value: 'Flagged' }, { type: 'star' }]);

    const stored = await deliver(user.username);

    // The returned DTO is read AFTER the rules ran.
    expect(stored.labels).toEqual(['Flagged']);
    expect(stored.flags.starred).toBe(true);
    expect(mockSendInboxEmailPush).toHaveBeenCalledTimes(1);
    expect(mockEmitEmailNew).toHaveBeenCalledTimes(1);
  });

  it('delivers and notifies when a rule fails', async () => {
    const user = await recipient();
    const inbox = await folderOf(user.id, '\\Inbox');
    // A move to a folder that no longer exists: the action throws.
    await rule(user.id, [{ type: 'move', value: `missing-${unique()}` }]);

    const stored = await deliver(user.username);

    expect((await stateOf(stored.id)).mailboxId).toBe(inbox);
    expect(mockSendInboxEmailPush).toHaveBeenCalledTimes(1);
    expect(mockEmitEmailNew).toHaveBeenCalledTimes(1);
  });
});
