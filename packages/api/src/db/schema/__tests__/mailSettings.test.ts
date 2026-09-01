/**
 * The six per-user mail tables — filters (with their two ordered rule lists),
 * templates, bundles, contacts, reminders — plus the global sender-avatar
 * cache, against a REAL Postgres.
 *
 * Four decisions here are the kind that look identical whether they are right
 * or wrong, so each has a check that can only pass one way:
 *
 *   1. `bundles` is now case-INSENSITIVE unique, which Mongo's index was not.
 *   2. A filter with no conditions or no actions is REPRESENTABLE in SQL —
 *      Mongoose's two `length > 0` validators have no constraint counterpart —
 *      so `incompleteEmailFilters()` is the enforcement point and it has to
 *      actually find one.
 *   3. `contacts.search_vector` must populate from BOTH indexed fields.
 *   4. `sender_avatars` is the table whose correctness used to depend on a
 *      sweep job; `senderAvatarIsFresh()` is what moves it off that dependency.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, getTableName, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { EXPIRY_SWEEP_TARGETS } from '../../expiry';
import { bundles } from '../bundles';
import { contacts } from '../contacts';
import { emailFilterActions } from '../emailFilterActions';
import { emailFilterConditions } from '../emailFilterConditions';
import { emailFilters, incompleteEmailFilters } from '../emailFilters';
import { emailTemplates } from '../emailTemplates';
import { mailboxes } from '../mailboxes';
import { messages } from '../messages';
import { reminders } from '../reminders';
import { senderAvatarIsFresh, senderAvatars } from '../senderAvatars';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `not_null_violation`. */
const NOT_NULL_VIOLATION = '23502';

const unique = () => randomUUID().replace(/-/g, '');

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('email_templates — case-insensitive unique, as Mongo`s collation was', () => {
  it('refuses a second template differing only by case', async () => {
    const userId = await owner();
    await getDb()
      .insert(emailTemplates)
      .values({ userId, name: 'Out of office', subject: 'Away', body: 'away' });

    const error = await rejection(
      getDb()
        .insert(emailTemplates)
        .values({ userId, name: 'OUT OF OFFICE', subject: 'Away', body: 'away' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('stores the name exactly as typed — only the comparison ignores case', async () => {
    const userId = await owner();
    await getDb()
      .insert(emailTemplates)
      .values({ userId, name: 'PayPal receipt', subject: '', body: 'x' });

    const [row] = await getDb()
      .select({ name: emailTemplates.name, subject: emailTemplates.subject })
      .from(emailTemplates)
      .where(eq(emailTemplates.userId, userId));

    expect(row.name).toBe('PayPal receipt');
    expect(row.subject).toBe('');
  });

  it('refuses a template with no subject supplied — Mongoose`s `default: \'\'` was application-side', async () => {
    // `''` is not available as a column default in this schema
    // (`schemaInvariants.test.ts`), so the writer supplies it. An insert that
    // forgets fails loudly rather than inventing a value.
    const userId = await owner();
    const error = await rejection(
      getDb().execute(sql`
        insert into email_templates (id, user_id, name, body)
        values (${unique()}, ${userId}, ${`T-${unique()}`}, 'x')
      `)
    );

    expect(pgErrorCode(error)).toBe(NOT_NULL_VIOLATION);
  });

  it('scopes the uniqueness to one user', async () => {
    const name = `Shared-${unique()}`;
    await getDb()
      .insert(emailTemplates)
      .values({ userId: await owner(), name, subject: '', body: 'x' });
    await expect(
      getDb().insert(emailTemplates).values({ userId: await owner(), name, subject: '', body: 'x' })
    ).resolves.toBeDefined();
  });
});

describe('bundles — the case-sensitivity Mongo left inconsistent', () => {
  it('refuses a second bundle differing only by case', async () => {
    // Mongo's `{userId, name}` unique index carried NO collation, while the two
    // sibling models naming the same kind of thing (`Label`, `EmailTemplate`)
    // both did. That was an omission, not a decision: nothing in the product
    // treats a bundle name as case-sensitive. Replicating it would carry the
    // typo into a schema designed from scratch.
    const userId = await owner();
    await getDb().insert(bundles).values({ userId, name: 'Promotions' });

    const error = await rejection(
      getDb().insert(bundles).values({ userId, name: 'promotions' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('applies the same defaults Mongo declared', async () => {
    const userId = await owner();
    const [row] = await getDb()
      .insert(bundles)
      .values({ userId, name: `Social-${unique()}` })
      .returning();

    expect(row.icon).toBe('folder-outline');
    expect(row.color).toBe('#5F6368');
    expect(row.matchLabels).toEqual([]);
    expect(row.enabled).toBe(true);
    expect(row.collapsed).toBe(true);
    expect(row.order).toBe(0);
  });

  it('matches messages by label name through the array both tables share', async () => {
    const userId = await owner();
    const label = `Shopping-${unique().slice(0, 8)}`;
    const [mailbox] = await getDb()
      .insert(mailboxes)
      .values({ userId, name: 'Inbox', path: `INBOX-${unique()}` })
      .returning({ id: mailboxes.id });
    await getDb().insert(bundles).values({ userId, name: `Promos-${unique()}`, matchLabels: [label] });
    const [message] = await getDb()
      .insert(messages)
      .values({
        userId,
        mailboxId: mailbox.id,
        messageId: `<${unique()}@oxy.so>`,
        fromAddress: 'shop@example.com',
        subject: '',
        size: 10,
        date: new Date(),
        labels: [label],
      })
      .returning({ id: messages.id });

    const matched = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(bundles, sql`${messages.labels} && ${bundles.matchLabels}`)
      .where(and(eq(messages.userId, userId), eq(bundles.userId, userId)));

    expect(matched.map((row) => row.id)).toEqual([message.id]);
  });
});

describe('email_filters — ordered rule lists and the invariant SQL cannot hold', () => {
  async function completeFilter(userId: string): Promise<string> {
    const [filter] = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Rule-${unique()}` })
      .returning({ id: emailFilters.id });

    await getDb().insert(emailFilterConditions).values([
      { filterId: filter.id, ord: 0, field: 'from', operator: 'contains', value: '@example.com' },
      { filterId: filter.id, ord: 1, field: 'subject', operator: 'starts-with', value: '[ALERT]' },
    ]);
    await getDb()
      .insert(emailFilterActions)
      .values({ filterId: filter.id, ord: 0, type: 'label', value: 'Alerts' });

    return filter.id;
  }

  it('preserves the order the user arranged', async () => {
    const filterId = await completeFilter(await owner());

    const conditions = await getDb()
      .select({ field: emailFilterConditions.field })
      .from(emailFilterConditions)
      .where(eq(emailFilterConditions.filterId, filterId))
      .orderBy(asc(emailFilterConditions.ord));

    expect(conditions.map((row) => row.field)).toEqual(['from', 'subject']);
  });

  it('keeps the ordering total', async () => {
    const userId = await owner();
    const [filter] = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Rule-${unique()}` })
      .returning({ id: emailFilters.id });
    await getDb()
      .insert(emailFilterActions)
      .values({ filterId: filter.id, ord: 0, type: 'star' });

    const error = await rejection(
      getDb().insert(emailFilterActions).values({ filterId: filter.id, ord: 0, type: 'archive' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a field, operator or action type outside its closed set', async () => {
    const userId = await owner();
    const [filter] = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Rule-${unique()}` })
      .returning({ id: emailFilters.id });

    const badField = await rejection(
      getDb().execute(sql`
        insert into email_filter_conditions (id, filter_id, ord, field, operator, value)
        values (${unique()}, ${filter.id}, 0, 'reply-to', 'contains', 'x')
      `)
    );
    const badOperator = await rejection(
      getDb().execute(sql`
        insert into email_filter_conditions (id, filter_id, ord, field, operator, value)
        values (${unique()}, ${filter.id}, 1, 'from', 'matches-regex', 'x')
      `)
    );
    const badAction = await rejection(
      getDb().execute(sql`
        insert into email_filter_actions (id, filter_id, ord, type)
        values (${unique()}, ${filter.id}, 0, 'shred')
      `)
    );

    expect(pgErrorCode(badField)).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(badOperator)).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(badAction)).toBe(CHECK_VIOLATION);
  });

  it('finds a filter with no actions — the state a CHECK cannot forbid', async () => {
    // Mongoose declared `validate: [(v) => v.length > 0]` on both arrays.
    // Postgres cannot express "this row must have a child" in a CHECK, and the
    // only declarative alternative is hand-written trigger DDL drizzle-kit
    // cannot emit. So the invariant is a PREDICATE, and this is the proof it
    // catches what the validator caught: a rule that matches mail and does
    // nothing with it.
    const userId = await owner();
    const [conditionsOnly] = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Half-${unique()}` })
      .returning({ id: emailFilters.id });
    await getDb().insert(emailFilterConditions).values({
      filterId: conditionsOnly.id,
      ord: 0,
      field: 'from',
      operator: 'contains',
      value: '@spam.example',
    });

    const broken = await getDb()
      .select({ id: emailFilters.id })
      .from(emailFilters)
      .where(and(eq(emailFilters.userId, userId), incompleteEmailFilters()));

    expect(broken.map((row) => row.id)).toEqual([conditionsOnly.id]);
  });

  it('finds a filter with no conditions — a rule that matches everything', async () => {
    const userId = await owner();
    const [actionsOnly] = await getDb()
      .insert(emailFilters)
      .values({ userId, name: `Half-${unique()}` })
      .returning({ id: emailFilters.id });
    await getDb()
      .insert(emailFilterActions)
      .values({ filterId: actionsOnly.id, ord: 0, type: 'delete' });

    const broken = await getDb()
      .select({ id: emailFilters.id })
      .from(emailFilters)
      .where(and(eq(emailFilters.userId, userId), incompleteEmailFilters()));

    expect(broken.map((row) => row.id)).toEqual([actionsOnly.id]);
  });

  it('leaves a complete filter alone', async () => {
    const userId = await owner();
    await completeFilter(userId);

    const broken = await getDb()
      .select({ id: emailFilters.id })
      .from(emailFilters)
      .where(and(eq(emailFilters.userId, userId), incompleteEmailFilters()));

    expect(broken).toEqual([]);
  });

  it('takes both rule lists with the filter', async () => {
    const filterId = await completeFilter(await owner());
    await getDb().delete(emailFilters).where(eq(emailFilters.id, filterId));

    const conditions = await getDb()
      .select({ id: emailFilterConditions.id })
      .from(emailFilterConditions)
      .where(eq(emailFilterConditions.filterId, filterId));
    const actions = await getDb()
      .select({ id: emailFilterActions.id })
      .from(emailFilterActions)
      .where(eq(emailFilterActions.filterId, filterId));

    expect(conditions).toEqual([]);
    expect(actions).toEqual([]);
  });
});

describe('contacts', () => {
  it('is unique per user and address', async () => {
    const userId = await owner();
    const email = `ada-${unique()}@example.com`;
    await getDb().insert(contacts).values({ userId, name: 'Ada', email });

    const error = await rejection(
      getDb().insert(contacts).values({ userId, name: 'Ada again', email })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    await expect(
      getDb().insert(contacts).values({ userId: await owner(), name: 'Ada', email })
    ).resolves.toBeDefined();
  });

  it('builds the search vector from BOTH indexed fields', async () => {
    // Mongo's index covered `name` and `email`. A vector built from only one
    // would still satisfy a single-term match, so both are asserted together.
    const userId = await owner();
    const nameTerm = `Zylophant${unique().slice(0, 8)}`;
    const emailLocal = `betacontact${unique().slice(0, 8)}`;
    await getDb()
      .insert(contacts)
      .values({ userId, name: `${nameTerm} Lovelace`, email: `${emailLocal}@example.com` });

    // Two predicates, ANDed: the first lexeme can only come from `name`, the
    // second only from `email` (Postgres tokenizes an address as ONE `email`
    // lexeme, so the local part alone never matches). A vector built from one
    // field satisfies neither pair.
    const found = await getDb().execute<{ id: string }>(sql`
      select id from contacts
      where user_id = ${userId}
        and search_vector @@ plainto_tsquery('english', ${nameTerm})
        and search_vector @@ plainto_tsquery('english', ${`${emailLocal}@example.com`})
    `);

    expect(found).toHaveLength(1);
  });

  it('indexes only the starred rows', async () => {
    const [row] = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'contacts_starred_idx'
    `);
    expect(row.indexdef).toContain('WHERE');
    expect(row.indexdef).toContain('starred');
  });

  it('goes with the account', async () => {
    const userId = await owner();
    await getDb()
      .insert(contacts)
      .values({ userId, name: 'Ada', email: `ada-${unique()}@example.com` });

    await getDb().delete(users).where(eq(users.id, userId));

    const remaining = await getDb()
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.userId, userId));
    expect(remaining).toEqual([]);
  });
});

describe('reminders', () => {
  it('survives the message it was created from', async () => {
    // `CASCADE` would delete the USER's note because a mail was deleted. NULL
    // already means "not attached to a message", which is exactly what a
    // deleted message leaves behind.
    const userId = await owner();
    const [mailbox] = await getDb()
      .insert(mailboxes)
      .values({ userId, name: 'Inbox', path: `INBOX-${unique()}` })
      .returning({ id: mailboxes.id });
    const [message] = await getDb()
      .insert(messages)
      .values({
        userId,
        mailboxId: mailbox.id,
        messageId: `<${unique()}@oxy.so>`,
        fromAddress: 'a@b.c',
        subject: '',
        size: 1,
        date: new Date(),
      })
      .returning({ id: messages.id });
    const [reminder] = await getDb()
      .insert(reminders)
      .values({
        userId,
        text: 'Reply to this',
        remindAt: new Date(Date.now() + 3_600_000),
        relatedMessageId: message.id,
      })
      .returning({ id: reminders.id });

    await getDb().delete(messages).where(eq(messages.id, message.id));

    const [row] = await getDb()
      .select({ id: reminders.id, relatedMessageId: reminders.relatedMessageId })
      .from(reminders)
      .where(eq(reminders.id, reminder.id));

    expect(row.id).toBe(reminder.id);
    expect(row.relatedMessageId).toBeNull();
  });

  it('indexes only the ones the cron will deliver', async () => {
    const [row] = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'reminders_due_idx'
    `);
    expect(row.indexdef).toContain('WHERE');
    expect(row.indexdef).toContain('completed');
  });
});

describe('sender_avatars — the table whose correctness depended on a job', () => {
  const target = EXPIRY_SWEEP_TARGETS.find(
    (entry) => getTableName(entry.table) === 'sender_avatars'
  );

  it('is registered for sweeping with the deadline shape Mongo declared', () => {
    // Mongo hid the TTL as a FIELD option — `expiresAt: { index: { expires: 0 } }`
    // — rather than a `schema.index()` call, which is exactly how it gets missed.
    expect(target).toBeDefined();
    expect(target?.retentionSeconds).toBe(0);
  });

  it('is unique per address', async () => {
    const email = `sender-${unique()}@example.com`;
    await getDb().insert(senderAvatars).values({
      email,
      source: 'gravatar',
      avatarPath: '/email/proxy?url=x',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const error = await rejection(
      getDb()
        .insert(senderAvatars)
        .values({ email, source: 'none', expiresAt: new Date(Date.now() + 86_400_000) })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('withholds an expired row from a read, without waiting for the sweep', async () => {
    // THE point of `senderAvatarIsFresh`. Both reads in
    // `senderAvatar.service.ts` return the cached row with no expiry predicate,
    // so today the only thing stopping a stale avatar being served is the TTL
    // monitor having got there first. With the filter, an expired row still
    // physically present is simply not returned, and the sweep drops to
    // housekeeping.
    const fresh = `fresh-${unique()}@example.com`;
    const stale = `stale-${unique()}@example.com`;
    await getDb().insert(senderAvatars).values([
      {
        email: fresh,
        source: 'oxy',
        avatarPath: '/api/assets/1/stream',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        email: stale,
        source: 'favicon',
        avatarPath: '/email/proxy?url=old',
        expiresAt: new Date(Date.now() - 1_000),
      },
    ]);

    const visible = await getDb()
      .select({ email: senderAvatars.email })
      .from(senderAvatars)
      .where(and(sql`${senderAvatars.email} in (${fresh}, ${stale})`, senderAvatarIsFresh()));

    expect(visible.map((row) => row.email)).toEqual([fresh]);

    // And the stale row IS still there — which is what makes the filter, rather
    // than the sweep, the thing that kept it off the screen.
    const present = await getDb()
      .select({ email: senderAvatars.email })
      .from(senderAvatars)
      .where(eq(senderAvatars.email, stale));
    expect(present).toHaveLength(1);
  });

  it('is swept once the job runs', async () => {
    if (!target) throw new Error('sender_avatars is not registered for sweeping');
    const stale = `swept-${unique()}@example.com`;
    await getDb()
      .insert(senderAvatars)
      .values({ email: stale, source: 'none', expiresAt: new Date(Date.now() - 60_000) });

    await sweepExpiredRows(getDb(), target);

    const remaining = await getDb()
      .select({ email: senderAvatars.email })
      .from(senderAvatars)
      .where(eq(senderAvatars.email, stale));
    expect(remaining).toEqual([]);
  });

  it('refuses a source outside the closed set', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into sender_avatars (id, email, source, expires_at)
        values (${unique()}, ${`x-${unique()}@example.com`}, 'clearbit', now() + interval '1 day')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('has no created_at/updated_at pair — `resolved_at` IS the birth column', async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'sender_avatars'
    `);
    const names = columns.map((row) => row.column_name);

    expect(names).toContain('resolved_at');
    expect(names).not.toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});
