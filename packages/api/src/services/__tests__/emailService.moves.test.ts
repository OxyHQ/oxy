/**
 * Moving mail, and what a move tells the other devices, against a REAL
 * Postgres.
 *
 * Every move ends in `email:changed` naming the folders it touched and an
 * `email:unread_count` for each, and the counts are what a badge shows. So
 * what is asserted is the exact sequence of emits, with exact non-zero
 * numbers, rather than that "an event was sent". The folder a row LEFT is the
 * one that goes wrong quietly: it is read, not written, and a stale read still
 * produces a plausible event.
 */

const mockGetIO = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: (...args: unknown[]) => mockGetIO(...args),
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `move${unique().slice(0, 10)}`, nameFirst: 'Test', color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

async function store(
  userId: string,
  mailboxId: string,
  values: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: 10,
      date: new Date(),
      ...values,
    })
    .returning({ id: messages.id });
  return row.id;
}

/** Route every socket emit into one list, as `{ event, payload }` pairs in order. */
function captureEmits(): Array<{ event: string; payload: unknown }> {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  mockGetIO.mockReturnValue({
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  });
  return emitted;
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
});

describe('bulk changes', () => {
  it('announces a 100-row bulk change row by row, but recounts each folder once', async () => {
    const userId = await owner();
    const source = await emailService.createMailbox(userId, `Src-${unique()}`);
    const target = await emailService.createMailbox(userId, `Dst-${unique()}`);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(await store(userId, source.id, { seen: false }));

    let emitted = captureEmits();
    await emailService.bulkUpdateMessageFlags(userId, ids, { seen: true });
    expect(emitted.filter((e) => e.event === 'email:changed')).toHaveLength(100);
    expect(emitted.filter((e) => e.event === 'email:unread_count')).toEqual([
      { event: 'email:unread_count', payload: { mailboxId: source.id, unread: 0 } },
    ]);

    await emailService.bulkUpdateMessageFlags(userId, ids.slice(0, 3), { seen: false });
    emitted = captureEmits();
    await emailService.bulkMoveMessages(userId, ids, target.id);
    const changed = emitted.filter((e) => e.event === 'email:changed');
    expect(changed).toHaveLength(100);
    // Every row names the folder it left as well as the one it landed in.
    expect(changed[0].payload).toEqual({
      id: expect.any(String),
      mailboxIds: [source.id, target.id],
      reason: 'moved',
    });
    expect(emitted.filter((e) => e.event === 'email:unread_count')).toEqual([
      { event: 'email:unread_count', payload: { mailboxId: source.id, unread: 0 } },
      { event: 'email:unread_count', payload: { mailboxId: target.id, unread: 3 } },
    ]);
  });
});
