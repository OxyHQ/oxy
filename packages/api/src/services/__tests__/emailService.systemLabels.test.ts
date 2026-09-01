/**
 * System labels are constants, not rows in `labels` — and applying labels is
 * now ONE statement.
 *
 * The risk that came with the constants: any code path that validates a label
 * by looking it up now rejects the eight built-in ones, because they have no
 * row to find. The risk that came with the port: Mongo could not `$addToSet`
 * and `$pull` the same field in one operation, so `updateMessageLabels` ran two
 * `updateOne` calls with a window between them. Postgres rewrites the array
 * once, which means the PRECEDENCE Mongo got from ordering — add, then remove —
 * has to be stated in the expression instead. A name in both lists must end up
 * removed, and an existing name must not be duplicated.
 *
 * Everything here runs against a real Postgres: the guarantees are about what
 * the column ends up holding, which a mocked `updateOne` cannot observe.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: {}, default: {} }));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { labels } from '../../db/schema/labels';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { SYSTEM_LABELS } from '../../constants/systemLabels';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function messageIn(userId: string, initialLabels: string[] = []): Promise<string> {
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'INBOX', path: `INBOX-${unique()}`, specialUse: '\\Inbox' })
    .returning({ id: mailboxes.id });
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId: mailbox.id,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: 10,
      labels: initialLabels,
      date: new Date(),
    })
    .returning({ id: messages.id });
  return row.id;
}

async function storedLabels(messageId: string): Promise<string[]> {
  const [row] = await getDb()
    .select({ labels: messages.labels })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row.labels;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('updateMessageLabels — system labels have no row', () => {
  it('applies a built-in label without looking for a row', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId);

    const updated = await emailService.updateMessageLabels(userId, messageId, ['Work'], []);

    expect(updated.labels).toEqual(['Work']);
    expect(await storedLabels(messageId)).toEqual(['Work']);
  });

  it('still rejects a label that exists neither as a constant nor as a row', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId);

    await expect(
      emailService.updateMessageLabels(userId, messageId, ['Nonexistent'], []),
    ).rejects.toThrow(/Labels not found: Nonexistent/);

    // The rejection happens BEFORE the write, so nothing was applied.
    expect(await storedLabels(messageId)).toEqual([]);
  });

  it('accepts a built-in and a user-made label together', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId);
    await emailService.createLabel(userId, 'Recipes', '#123456');

    const updated = await emailService.updateMessageLabels(
      userId,
      messageId,
      ['Work', 'Recipes'],
      [],
    );

    expect(updated.labels).toEqual(['Work', 'Recipes']);
  });

  it('rejects a user label that belongs to somebody else', async () => {
    const mine = await owner();
    const theirs = await owner();
    const messageId = await messageIn(mine);
    await emailService.createLabel(theirs, 'Private', '#000000');

    await expect(
      emailService.updateMessageLabels(mine, messageId, ['Private'], []),
    ).rejects.toThrow(/Labels not found: Private/);
  });
});

describe('updateMessageLabels — one statement, and its precedence', () => {
  it('adds and removes in a single write', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId, ['Social', 'Updates']);

    const updated = await emailService.updateMessageLabels(
      userId,
      messageId,
      ['Travel'],
      ['Social'],
    );

    expect(updated.labels).toEqual(['Updates', 'Travel']);
  });

  it('removes a name that appears in BOTH lists — Mongo added then pulled', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId, ['Work']);

    const updated = await emailService.updateMessageLabels(
      userId,
      messageId,
      ['Work', 'Travel'],
      ['Work'],
    );

    expect(updated.labels).toEqual(['Travel']);
  });

  it('never duplicates a label the message already carries', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId, ['Finance']);

    const updated = await emailService.updateMessageLabels(userId, messageId, ['Finance'], []);
    expect(updated.labels).toEqual(['Finance']);
  });

  it('adds a repeated name once — `$addToSet` was a SET operation', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId);

    const updated = await emailService.updateMessageLabels(
      userId,
      messageId,
      ['Work', 'Work'],
      [],
    );
    expect(updated.labels).toEqual(['Work']);
  });

  it('keeps the surviving order — kept in place, new ones appended', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId, ['Personal', 'Work', 'Finance']);

    const updated = await emailService.updateMessageLabels(
      userId,
      messageId,
      ['Travel', 'Social'],
      ['Work'],
    );

    expect(updated.labels).toEqual(['Personal', 'Finance', 'Travel', 'Social']);
  });

  it('empties the array rather than nulling it', async () => {
    const userId = await owner();
    const messageId = await messageIn(userId, ['Work']);

    const updated = await emailService.updateMessageLabels(userId, messageId, [], ['Work']);
    expect(updated.labels).toEqual([]);
    expect(await storedLabels(messageId)).toEqual([]);
  });

  it('refuses to touch another account`s message', async () => {
    const mine = await owner();
    const theirs = await owner();
    const messageId = await messageIn(theirs);

    await expect(
      emailService.updateMessageLabels(mine, messageId, ['Work'], []),
    ).rejects.toThrow(/Message not found/);
  });
});

describe('labels — the case-insensitive unique index', () => {
  it('lists the eight constants ahead of the user`s own', async () => {
    const userId = await owner();
    await emailService.createLabel(userId, `Zebra-${unique().slice(0, 6)}`, '#abcdef');

    const listed = await emailService.listLabels(userId);

    expect(listed.slice(0, SYSTEM_LABELS.length).map((l) => l.name)).toEqual(
      SYSTEM_LABELS.map((l) => l.name),
    );
    expect(listed[0]).toMatchObject({ system: true });
    expect(listed[listed.length - 1]).toMatchObject({ system: false });
  });

  it('shadows a stored row that duplicates a constant, so no name appears twice', async () => {
    const userId = await owner();
    await getDb().insert(labels).values({ userId, name: 'Work', color: '#111111', order: 0 });

    const names = (await emailService.listLabels(userId)).map((l) => l.name);
    expect(names.filter((name) => name === 'Work')).toHaveLength(1);
  });

  it('refuses a name differing only in case — Mongo`s `strength: 2` collation', async () => {
    const userId = await owner();
    const name = `Receipts-${unique().slice(0, 6)}`;
    await emailService.createLabel(userId, name, '#abcdef');

    await expect(emailService.createLabel(userId, name.toUpperCase(), '#abcdef')).rejects.toThrow(
      /already exists/,
    );
  });

  it('refuses to create, edit or delete a built-in', async () => {
    const userId = await owner();
    await expect(emailService.createLabel(userId, 'work', '#abcdef')).rejects.toThrow(
      /already exists/,
    );
    await expect(
      emailService.updateLabel(userId, 'system:work', { name: 'Job' }),
    ).rejects.toThrow(/cannot be edited/);
    await expect(emailService.deleteLabel(userId, 'system:work')).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('detaches a deleted label from every message it was on', async () => {
    const userId = await owner();
    const name = `Ephemeral-${unique().slice(0, 6)}`;
    const label = await emailService.createLabel(userId, name, '#abcdef');
    const messageId = await messageIn(userId);
    await emailService.updateMessageLabels(userId, messageId, [name, 'Work'], []);
    expect(await storedLabels(messageId)).toEqual([name, 'Work']);

    await emailService.deleteLabel(userId, label.id);

    expect(await storedLabels(messageId)).toEqual(['Work']);
    expect(await emailService.listLabels(userId)).not.toContainEqual(
      expect.objectContaining({ id: label.id }),
    );
  });

  it('leaves another account`s identically-named label attached', async () => {
    const mine = await owner();
    const theirs = await owner();
    const name = `Shared-${unique().slice(0, 6)}`;
    const mineLabel = await emailService.createLabel(mine, name, '#abcdef');
    await emailService.createLabel(theirs, name, '#abcdef');
    const theirMessage = await messageIn(theirs);
    await emailService.updateMessageLabels(theirs, theirMessage, [name], []);

    await emailService.deleteLabel(mine, mineLabel.id);

    expect(await storedLabels(theirMessage)).toEqual([name]);
  });
});
