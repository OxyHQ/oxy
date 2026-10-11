/**
 * Renaming and creating labels, against a REAL Postgres.
 *
 * A label is referenced BY NAME — `messages.labels`, `bundles.match_labels`, a
 * filter's `label` action, a saved search's `label` filter and its `label:`
 * query operator. Renaming only the `labels` row orphaned every one of them:
 * the messages kept a name no label had, so the chip vanished and the label's
 * own view went empty. Every assertion below reads the referencing row back
 * after the rename, because "the label row changed" was always true.
 *
 * The names are unique per user IGNORING CASE
 * (`labels_user_id_lower_name_key`); a collision used to surface as a 500.
 */

const mockEmitEmailChanged = jest.fn();
jest.mock('../inboxRealtime', () => ({
  ...jest.requireActual('../inboxRealtime'),
  emitEmailChanged: (...args: unknown[]) => mockEmitEmailChanged(...args),
  emitEmailNew: jest.fn(),
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn() },
}));
jest.mock('../cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn() },
}));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: {}, default: {} }));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { bundles } from '../../db/schema/bundles';
import { emailFilterActions } from '../../db/schema/emailFilterActions';
import { emailSavedSearches } from '../../db/schema/emailSavedSearches';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { ConflictError } from '../../utils/error';
import { emailService, renameLabelInSearchQuery } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function folder(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'Folder', path: `Folder-${unique()}` })
    .returning({ id: mailboxes.id });
  return row.id;
}

async function store(userId: string, mailboxId: string, labels: string[]): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: 1,
      labels,
      date: new Date(),
    })
    .returning({ id: messages.id });
  return row.id;
}

async function labelsOf(messageId: string): Promise<string[]> {
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

beforeEach(() => {
  mockEmitEmailChanged.mockReset();
});

describe('updateLabel — a rename follows the label everywhere it is named', () => {
  it('renames the label on every message carrying it, and on nobody else`s', async () => {
    const userId = await owner();
    const other = await owner();
    const box = await folder(userId);
    const otherBox = await folder(other);
    const label = await emailService.createLabel(userId, 'Projects', '#000000');
    await emailService.createLabel(other, 'Projects', '#000000');

    const tagged = await store(userId, box, ['Keep', 'Projects', 'Later']);
    const untagged = await store(userId, box, ['Keep']);
    const theirs = await store(other, otherBox, ['Projects']);

    const renamed = await emailService.updateLabel(userId, label.id, { name: 'Day job' });

    expect(renamed.name).toBe('Day job');
    // Position preserved: the rename is in place, not remove-then-append.
    expect(await labelsOf(tagged)).toEqual(['Keep', 'Day job', 'Later']);
    expect(await labelsOf(untagged)).toEqual(['Keep']);
    expect(await labelsOf(theirs)).toEqual(['Projects']);

    // The renamed messages are findable under the new name — the actual
    // symptom was this view going empty.
    const listed = await emailService.listMessages(userId, null, { label: 'Day job' });
    expect(listed.data.map((m) => m.id)).toEqual([tagged]);

    expect(mockEmitEmailChanged).toHaveBeenCalledWith({
      userId,
      id: label.id,
      mailboxIds: [box],
      reason: 'labels',
    });
  });

  it('never leaves the same name twice on a message that already carried the new one', async () => {
    const userId = await owner();
    const box = await folder(userId);
    const label = await emailService.createLabel(userId, 'Old', '#000000');
    // A stale `New` string, as an earlier orphaning rename would have left.
    const message = await store(userId, box, ['New', 'Old']);

    await emailService.updateLabel(userId, label.id, { name: 'New' });

    expect(await labelsOf(message)).toEqual(['New']);
  });

  it('renames it in bundles, filter rules and saved searches too', async () => {
    const userId = await owner();
    const label = await emailService.createLabel(userId, 'Receipts', '#000000');

    const [bundle] = await getDb()
      .insert(bundles)
      .values({ userId, name: `Bundle-${unique()}`, matchLabels: ['Receipts', 'Bills'] })
      .returning({ id: bundles.id });
    const filter = await emailService.createFilter(userId, {
      name: 'Tag receipts',
      enabled: true,
      matchAll: true,
      order: 0,
      conditions: [{ field: 'subject', operator: 'contains', value: 'receipt' }],
      actions: [
        { type: 'label', value: 'Receipts' },
        { type: 'label', value: 'Other' },
      ],
    });
    const search = await emailService.createSavedSearch(userId, {
      name: `Search-${unique()}`,
      query: 'from:shop label:Receipts invoice',
      filters: { label: 'Receipts', from: 'shop' },
    });

    await emailService.updateLabel(userId, label.id, { name: 'Paper trail' });

    const [bundleAfter] = await getDb()
      .select({ matchLabels: bundles.matchLabels })
      .from(bundles)
      .where(eq(bundles.id, bundle.id));
    expect(bundleAfter.matchLabels).toEqual(['Paper trail', 'Bills']);

    const actions = await getDb()
      .select({ ord: emailFilterActions.ord, value: emailFilterActions.value })
      .from(emailFilterActions)
      .where(eq(emailFilterActions.filterId, filter.id))
      .orderBy(emailFilterActions.ord);
    expect(actions.map((a) => a.value)).toEqual(['Paper trail', 'Other']);

    const [searchAfter] = await getDb()
      .select({ query: emailSavedSearches.query, filters: emailSavedSearches.filters })
      .from(emailSavedSearches)
      .where(eq(emailSavedSearches.id, search.id));
    expect(searchAfter.query).toBe('from:shop label:"Paper trail" invoice');
    expect(searchAfter.filters).toEqual({ label: 'Paper trail', from: 'shop' });
  });

  it('allows a case-only rename of the same label', async () => {
    const userId = await owner();
    const box = await folder(userId);
    const label = await emailService.createLabel(userId, 'holidays', '#000000');
    const message = await store(userId, box, ['holidays']);

    await expect(
      emailService.updateLabel(userId, label.id, { name: 'Holidays' }),
    ).resolves.toMatchObject({
      name: 'Holidays',
    });
    expect(await labelsOf(message)).toEqual(['Holidays']);
  });

  it('refuses a name another label holds in any case with 409, and changes nothing', async () => {
    const userId = await owner();
    const box = await folder(userId);
    const first = await emailService.createLabel(userId, 'Family', '#000000');
    await emailService.createLabel(userId, 'Friends', '#000000');
    const message = await store(userId, box, ['Family']);

    const attempt = emailService.updateLabel(userId, first.id, { name: 'FRIENDS' });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409 });

    expect(await labelsOf(message)).toEqual(['Family']);
    expect(mockEmitEmailChanged).not.toHaveBeenCalled();
  });

  it('only recolours when the name is unchanged, touching no message', async () => {
    const userId = await owner();
    const box = await folder(userId);
    const label = await emailService.createLabel(userId, 'Calm', '#000000');
    await store(userId, box, ['Calm']);

    await expect(
      emailService.updateLabel(userId, label.id, { name: 'Calm', color: '#ffffff' }),
    ).resolves.toMatchObject({
      name: 'Calm',
      color: '#ffffff',
    });
    expect(mockEmitEmailChanged).not.toHaveBeenCalled();
  });
});

describe('createLabel — a duplicate is a conflict, not a server error', () => {
  it('refuses a name that exists in another case with 409', async () => {
    const userId = await owner();
    await emailService.createLabel(userId, 'Taxes', '#000000');

    await expect(emailService.createLabel(userId, 'TAXES', '#000000')).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('turns the unique-index refusal of a racing create into 409 too', async () => {
    const userId = await owner();
    // Both pass the existence read before either inserts; the index decides.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => emailService.createLabel(userId, 'Race', '#000000')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ConflictError);
  });
});

describe('deleteLabel — announces the messages it changed', () => {
  it('emits one labels change for the folders whose messages lost the label', async () => {
    const userId = await owner();
    const box = await folder(userId);
    const label = await emailService.createLabel(userId, 'Gone', '#000000');
    const message = await store(userId, box, ['Gone', 'Stays']);

    await emailService.deleteLabel(userId, label.id);

    expect(await labelsOf(message)).toEqual(['Stays']);
    expect(mockEmitEmailChanged).toHaveBeenCalledWith({
      userId,
      id: label.id,
      mailboxIds: [box],
      reason: 'labels',
    });
  });
});

describe('renameLabelInSearchQuery', () => {
  it('rewrites only a label operator naming the old label, quoting as needed', () => {
    expect(renameLabelInSearchQuery('label:Old', 'Old', 'New')).toBe('label:New');
    expect(renameLabelInSearchQuery('label:"Old one" x', 'Old one', 'New')).toBe('label:New x');
    expect(renameLabelInSearchQuery('LABEL:Old', 'Old', 'Has "quote"')).toBe(`label:'Has "quote"'`);
    // Another label, and the bare word, are not this label.
    expect(renameLabelInSearchQuery('label:Older Old', 'Old', 'New')).toBe('label:Older Old');
    // Untouched queries keep their exact spacing.
    expect(renameLabelInSearchQuery('  from:a   b ', 'Old', 'New')).toBe('  from:a   b ');
  });
});
