/**
 * Filters, bundles, reminders, templates and contacts, against a REAL Postgres.
 *
 * Each of these lost something in the port that only a database can hold it to:
 *
 *   - **Filters** had two embedded arrays with `length > 0` validators.
 *     Postgres cannot express "this row must have a child" as a CHECK, so the
 *     write path owns the invariant inside the SAME transaction that writes the
 *     children — a violation has to roll the whole rule back, not leave a rule
 *     that silently matches everything.
 *   - **Bundles** gained case-insensitive uniqueness, which Mongo's index
 *     lacked while its two siblings had it.
 *   - **Reminders** had a read-then-write-per-row cron; it is one statement now.
 *   - **Templates** and **contacts** carry call-site obligations Mongoose
 *     discharged with setters that Postgres has no counterpart for.
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
import { emailFilterActions } from '../../db/schema/emailFilterActions';
import { emailFilterConditions } from '../../db/schema/emailFilterConditions';
import { emailFilters, incompleteEmailFilters } from '../../db/schema/emailFilters';
import { reminders } from '../../db/schema/reminders';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

function filterInput(overrides: Record<string, unknown> = {}) {
  return {
    name: `Rule ${unique().slice(0, 6)}`,
    enabled: true,
    matchAll: true,
    order: 0,
    conditions: [{ field: 'from' as const, operator: 'contains' as const, value: 'newsletter' }],
    actions: [{ type: 'star' as const }],
    ...overrides,
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('filters — the invariant Postgres cannot state as a CHECK', () => {
  it('writes a rule and its ordered children as one thing', async () => {
    const userId = await owner();

    const filter = await emailService.createFilter(
      userId,
      filterInput({
        conditions: [
          { field: 'from', operator: 'contains', value: 'ops@' },
          { field: 'subject', operator: 'starts-with', value: 'Alert' },
        ],
        actions: [
          { type: 'label', value: 'Work' },
          { type: 'mark-read' },
        ],
      }),
    );

    expect(filter.conditions).toEqual([
      { field: 'from', operator: 'contains', value: 'ops@' },
      { field: 'subject', operator: 'starts-with', value: 'Alert' },
    ]);
    // `value` is OMITTED for the actions that take none — Mongoose stored no
    // key at all rather than a null.
    expect(filter.actions).toEqual([{ type: 'label', value: 'Work' }, { type: 'mark-read' }]);
    expect(filter._id).toBe(filter.id);
  });

  it('rolls the whole rule back when it would have no actions', async () => {
    const userId = await owner();

    await expect(
      emailService.createFilter(userId, filterInput({ actions: [] })),
    ).rejects.toThrow(/at least one condition and one action/);

    // Nothing survived the rollback — not the parent, not the conditions.
    const rows = await getDb()
      .select({ id: emailFilters.id })
      .from(emailFilters)
      .where(eq(emailFilters.userId, userId));
    expect(rows).toEqual([]);
  });

  it('rolls back an EDIT that would strip a rule`s conditions', async () => {
    const userId = await owner();
    const filter = await emailService.createFilter(userId, filterInput());

    await expect(
      emailService.updateFilter(userId, filter.id, { conditions: [] }),
    ).rejects.toThrow(/at least one condition and one action/);

    const [reloaded] = await emailService.listFilters(userId);
    expect(reloaded.conditions).toHaveLength(1);
  });

  it('scopes the invariant to the rule being written, not to the whole table', async () => {
    // `incompleteEmailFilters()`'s outer parentheses are what make this true:
    // without them the predicate composes as `(id = $1 and …) or …` and every
    // write fails as soon as ANY broken rule exists anywhere.
    const userId = await owner();
    const orphan = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Broken ${unique().slice(0, 6)}` })
      .returning({ id: emailFilters.id });

    await expect(emailService.createFilter(userId, filterInput())).resolves.toBeDefined();

    const broken = await getDb()
      .select({ id: emailFilters.id })
      .from(emailFilters)
      .where(incompleteEmailFilters());
    expect(broken.map((row) => row.id)).toContain(orphan[0].id);
  });

  it('REPLACES a child list rather than merging into it', async () => {
    const userId = await owner();
    const filter = await emailService.createFilter(
      userId,
      filterInput({
        actions: [{ type: 'star' }, { type: 'mark-read' }],
      }),
    );

    const updated = await emailService.updateFilter(userId, filter.id, {
      actions: [{ type: 'archive' }],
    });

    expect(updated.actions).toEqual([{ type: 'archive' }]);
    const rows = await getDb()
      .select({ id: emailFilterActions.id })
      .from(emailFilterActions)
      .where(eq(emailFilterActions.filterId, filter.id));
    expect(rows).toHaveLength(1);
  });

  it('takes the children with the rule when it is deleted', async () => {
    const userId = await owner();
    const filter = await emailService.createFilter(userId, filterInput());

    await emailService.deleteFilter(userId, filter.id);

    expect(
      await getDb()
        .select({ id: emailFilterConditions.id })
        .from(emailFilterConditions)
        .where(eq(emailFilterConditions.filterId, filter.id)),
    ).toEqual([]);
    await expect(emailService.deleteFilter(userId, filter.id)).rejects.toThrow(/not found/);
  });

  it('lists a user`s rules in evaluation order and nobody else`s', async () => {
    const userId = await owner();
    const other = await owner();
    const second = await emailService.createFilter(userId, filterInput({ order: 2 }));
    const first = await emailService.createFilter(userId, filterInput({ order: 1 }));
    await emailService.createFilter(other, filterInput({ order: 0 }));

    const listed = await emailService.listFilters(userId);
    expect(listed.map((f) => f.id)).toEqual([first.id, second.id]);
  });
});

describe('bundles — uniqueness that is now case-insensitive', () => {
  it('seeds the four defaults exactly once', async () => {
    const userId = await owner();

    const first = await emailService.listBundles(userId);
    const second = await emailService.listBundles(userId);

    expect(first.map((b) => b.name)).toEqual(['Promotions', 'Social', 'Updates', 'Forums']);
    expect(second).toHaveLength(4);
    expect(first[0].matchLabels).toEqual(['Shopping']);
  });

  it('updates only the fields asked for', async () => {
    const userId = await owner();
    const [bundle] = await emailService.listBundles(userId);

    const updated = await emailService.updateBundle(userId, bundle.id, { collapsed: false });

    expect(updated.collapsed).toBe(false);
    expect(updated.enabled).toBe(bundle.enabled);
    expect(updated.matchLabels).toEqual(bundle.matchLabels);
  });

  it('refuses to touch another account`s bundle', async () => {
    const mine = await owner();
    const theirs = await owner();
    const [bundle] = await emailService.listBundles(theirs);

    await expect(emailService.updateBundle(mine, bundle.id, { enabled: false })).rejects.toThrow(
      /not found/,
    );
  });
});

describe('reminders', () => {
  it('creates, reads back, updates and deletes one', async () => {
    const userId = await owner();
    const remindAt = new Date(Date.now() + 3_600_000);

    const created = await emailService.createReminder(userId, {
      text: 'Follow up',
      remindAt: remindAt.toISOString(),
    });
    expect(created).toMatchObject({ text: 'Follow up', completed: false, pinned: false });
    expect(created._id).toBe(created.id);
    expect(created.remindAt.getTime()).toBe(remindAt.getTime());

    expect(await emailService.getReminder(userId, created.id)).toMatchObject({ id: created.id });

    const updated = await emailService.updateReminder(userId, created.id, { completed: true });
    expect(updated.completed).toBe(true);

    await emailService.deleteReminder(userId, created.id);
    await expect(emailService.getReminder(userId, created.id)).rejects.toThrow(/not found/);
  });

  it('lists open reminders pinned-first, hiding completed ones by default', async () => {
    const userId = await owner();
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 120_000);

    const early = await emailService.createReminder(userId, {
      text: 'early',
      remindAt: soon.toISOString(),
    });
    const pinned = await emailService.createReminder(userId, {
      text: 'pinned',
      remindAt: later.toISOString(),
    });
    await emailService.updateReminder(userId, pinned.id, { pinned: true });
    const done = await emailService.createReminder(userId, {
      text: 'done',
      remindAt: soon.toISOString(),
    });
    await emailService.updateReminder(userId, done.id, { completed: true });

    const open = await emailService.listReminders(userId);
    expect(open.data.map((r) => r.id)).toEqual([pinned.id, early.id]);
    expect(open.pagination).toMatchObject({ total: 2, hasMore: false });

    const all = await emailService.listReminders(userId, { includeCompleted: true });
    expect(all.pagination.total).toBe(3);
  });

  it('clears the snooze on every due reminder in one statement', async () => {
    const userId = await owner();
    const past = new Date(Date.now() - 60_000);

    const due = await emailService.createReminder(userId, {
      text: 'due',
      remindAt: past.toISOString(),
    });
    await emailService.updateReminder(userId, due.id, { snoozedUntil: past.toISOString() });
    const stillSnoozed = await emailService.createReminder(userId, {
      text: 'snoozed',
      remindAt: past.toISOString(),
    });
    await emailService.updateReminder(userId, stillSnoozed.id, {
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const processed = await emailService.processDueReminders();

    expect(processed).toBeGreaterThanOrEqual(1);
    const [cleared] = await getDb()
      .select({ snoozedUntil: reminders.snoozedUntil })
      .from(reminders)
      .where(eq(reminders.id, due.id));
    expect(cleared.snoozedUntil).toBeNull();

    const [untouched] = await getDb()
      .select({ snoozedUntil: reminders.snoozedUntil })
      .from(reminders)
      .where(eq(reminders.id, stillSnoozed.id));
    expect(untouched.snoozedUntil).not.toBeNull();
  });
});

describe('templates — the case-insensitive name', () => {
  it('creates, lists, updates and deletes one', async () => {
    const userId = await owner();
    const name = `Signature ${unique().slice(0, 6)}`;

    const created = await emailService.createTemplate(userId, { name, body: 'Regards' });
    expect(created).toMatchObject({ name, subject: '', body: 'Regards', order: 0 });

    expect((await emailService.listTemplates(userId)).map((t) => t.id)).toEqual([created.id]);

    const updated = await emailService.updateTemplate(userId, created.id, { subject: 'Hello' });
    expect(updated.subject).toBe('Hello');
    expect(updated.body).toBe('Regards');

    await emailService.deleteTemplate(userId, created.id);
    await expect(emailService.deleteTemplate(userId, created.id)).rejects.toThrow(/not found/);
  });

  it('refuses a name differing only in case', async () => {
    const userId = await owner();
    const name = `Reply ${unique().slice(0, 6)}`;
    await emailService.createTemplate(userId, { name, body: 'x' });

    await expect(
      emailService.createTemplate(userId, { name: name.toUpperCase(), body: 'y' }),
    ).rejects.toThrow(/already exists/);
  });

  it('lets two accounts hold the same template name', async () => {
    const name = `Shared ${unique().slice(0, 6)}`;
    const mine = await owner();
    const theirs = await owner();

    await expect(emailService.createTemplate(mine, { name, body: 'x' })).resolves.toBeDefined();
    await expect(emailService.createTemplate(theirs, { name, body: 'x' })).resolves.toBeDefined();
  });
});

describe('contacts — the normalization Mongoose did with a setter', () => {
  it('lower-cases and trims the address on create and on update', async () => {
    const userId = await owner();
    const local = `Contact${unique().slice(0, 8)}`;

    const created = await emailService.createContact(userId, {
      name: '  Bob  ',
      email: `  ${local}@Example.COM `,
    });
    expect(created.email).toBe(`${local}@example.com`.toLowerCase());
    expect(created.name).toBe('Bob');

    const updated = await emailService.updateContact(userId, created.id, {
      email: `  OTHER-${local}@Example.com  `,
    });
    expect(updated.email).toBe(`other-${local}@example.com`.toLowerCase());
  });

  it('refuses a second contact for the same address', async () => {
    const userId = await owner();
    const email = `dup${unique().slice(0, 8)}@example.com`;
    await emailService.createContact(userId, { name: 'One', email });

    await expect(
      emailService.createContact(userId, { name: 'Two', email: email.toUpperCase() }),
    ).rejects.toThrow(/already exists/);
  });

  it('searches name, email AND company as case-insensitive substrings', async () => {
    // `company` is the field the ported `tsvector` deliberately does NOT cover;
    // the query keeps searching it, which is what this pins.
    const userId = await owner();
    const tag = unique().slice(0, 8);
    const byCompany = await emailService.createContact(userId, {
      name: 'Someone',
      email: `someone-${tag}@example.com`,
      company: `Acme${tag}`,
    });

    const { data } = await emailService.listContacts(userId, { q: `ACME${tag}` });
    expect(data.map((c) => c.id)).toEqual([byCompany.id]);
  });

  it('lists starred contacts first, and filters to them on request', async () => {
    const userId = await owner();
    const tag = unique().slice(0, 8);
    await emailService.createContact(userId, { name: `Zeta${tag}`, email: `z-${tag}@example.com` });
    const starred = await emailService.createContact(userId, {
      name: `Alpha${tag}`,
      email: `a-${tag}@example.com`,
      starred: true,
    });

    const all = await emailService.listContacts(userId, { q: tag });
    expect(all.data[0].id).toBe(starred.id);
    expect(all.total).toBe(2);

    const onlyStarred = await emailService.listContacts(userId, { q: tag, starred: true });
    expect(onlyStarred.data.map((c) => c.id)).toEqual([starred.id]);
  });

  it('auto-collects a new correspondent and only touches the stamp on the next one', async () => {
    const userId = await owner();
    const email = `auto${unique().slice(0, 8)}@example.com`;

    await emailService.autoCollectContacts(userId, [{ name: 'First Seen', address: ` ${email.toUpperCase()} ` }]);
    const { data: afterFirst } = await emailService.listContacts(userId, { q: email });
    expect(afterFirst[0]).toMatchObject({ name: 'First Seen', email, autoCollected: true });
    const firstStamp = afterFirst[0].lastContactedAt;

    await emailService.autoCollectContacts(userId, [{ name: 'Different Name', address: email }]);
    const { data: afterSecond, total } = await emailService.listContacts(userId, { q: email });

    expect(total).toBe(1);
    // The name is insert-only, exactly as `$setOnInsert` made it.
    expect(afterSecond[0].name).toBe('First Seen');
    expect(afterSecond[0].lastContactedAt?.getTime()).toBeGreaterThanOrEqual(
      firstStamp?.getTime() ?? 0,
    );
  });

  it('falls back to the address local part when no name was supplied', async () => {
    const userId = await owner();
    const local = `nameless${unique().slice(0, 8)}`;

    await emailService.autoCollectContacts(userId, [{ address: `${local}@example.com` }]);

    const { data } = await emailService.listContacts(userId, { q: local });
    expect(data[0].name).toBe(local);
  });

  it('suggests contacts starred-first, then most recently contacted', async () => {
    const userId = await owner();
    const tag = unique().slice(0, 8);
    await emailService.createContact(userId, { name: `Plain${tag}`, email: `p-${tag}@example.com` });
    await emailService.createContact(userId, {
      name: `Star${tag}`,
      email: `s-${tag}@example.com`,
      starred: true,
    });

    const suggestions = await emailService.searchContacts(userId, tag);
    expect(suggestions[0]).toEqual({ name: `Star${tag}`, address: `s-${tag}@example.com` });
    expect(suggestions).toHaveLength(2);
  });

  it('returns nothing for a query shorter than two characters', async () => {
    const userId = await owner();
    await expect(emailService.searchContacts(userId, 'a')).resolves.toEqual([]);
  });
});
