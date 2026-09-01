/**
 * `messages`, its two child tables, and `mailboxes`, against a REAL Postgres.
 *
 * Three things here are load-bearing and could each be subtly wrong while
 * looking right:
 *
 *   1. **The weighted text index.** Mongo's `weights: {subject: 10, text: 1}`
 *      becomes `setweight(..., 'A') || setweight(..., 'D')`. Postgres weights
 *      are fixed multipliers, so B or C would compile, index, and silently
 *      re-rank every search result — only a RANK comparison catches it.
 *   2. **The four hidden bodies.** `select: false` has no drizzle counterpart;
 *      `publicColumns` is the replacement, and it is worthless if the registry
 *      drifts from the columns Mongoose actually protected.
 *   3. **The child tables.** `to`/`cc`/`bcc` and `attachments` became rows
 *      precisely so they could be searched and joined; a `jsonb` port would
 *      pass a round-trip test and fail every one of those reads.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { files } from '../files';
import { mailboxes } from '../mailboxes';
import { messageAttachments } from '../messageAttachments';
import { MESSAGE_RECIPIENT_KINDS, messageRecipients } from '../messageRecipients';
import { messages } from '../messages';
import { MESSAGES_PROTECTED_COLUMNS, PROTECTED_COLUMNS_BY_TABLE } from '../protectedColumns';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `generated_always` — a write to a GENERATED ALWAYS column. */
const GENERATED_ALWAYS = '428C9';

/**
 * The `messages` fields `models/Message.ts` declares `select: false`, written
 * out rather than derived from the registry.
 *
 * Deriving them would make the assertion tautological: deleting a registry
 * entry would delete the expectation with it. This is the independent statement
 * of what Mongo protected.
 */
const MONGOOSE_SELECT_FALSE_MESSAGE_FIELDS = ['text', 'html', 'headers', 'encryptedBody'] as const;

const unique = () => randomUUID().replace(/-/g, '');

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function pgConstraint(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const name: unknown = Reflect.get(current, 'constraint_name');
    if (typeof name === 'string') return name;
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

async function mailbox(userId: string, path = `INBOX-${unique()}`): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'Inbox', path, specialUse: '\\Inbox' })
    .returning({ id: mailboxes.id });
  return row.id;
}

async function insertMessage(
  values: Partial<typeof messages.$inferInsert> & { userId: string; mailboxId: string }
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      messageId: `<${unique()}@oxy.so>`,
      fromAddress: 'sender@example.com',
      // NOT NULL with no default — the writer always supplies it, which is what
      // Mongoose's application-side `default: ''` did.
      subject: '',
      size: 2048,
      date: new Date(),
      ...values,
    })
    .returning({ id: messages.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('messages — the weighted text index', () => {
  it('ranks a subject match ten times a body match, as Mongo weighted it', async () => {
    // Mongo: `weights: {subject: 10, text: 1}`. Postgres weights are FIXED
    // multipliers — A=1.0, B=0.4, C=0.2, D=0.1 — so only the A/D pair
    // reproduces the ratio. B or C would index fine and quietly re-rank every
    // search result, which is why this compares RANKS and not just matches.
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const term = `zylophant${unique().slice(0, 8)}`;

    const inSubject = await insertMessage({
      userId,
      mailboxId,
      subject: `Your ${term} receipt`,
      text: 'nothing relevant in the body at all',
    });
    const inBody = await insertMessage({
      userId,
      mailboxId,
      subject: 'nothing relevant in the subject',
      text: `the word ${term} appears only down here`,
    });

    const ranked = await getDb().execute<{ id: string; rank: number }>(sql`
      select id, ts_rank('{0.1,0.2,0.4,1.0}'::float4[], search_vector,
                         to_tsquery('english', ${term})) as rank
      from messages
      where id in (${inSubject}, ${inBody})
      order by rank desc
    `);

    expect(ranked.map((row) => row.id)).toEqual([inSubject, inBody]);
    // A/D is 10:1. A/B would be 2.5, A/C 5 — both far outside this tolerance,
    // which is loose only against `float4`'s seven significant digits.
    expect(ranked[0].rank / ranked[1].rank).toBeCloseTo(10, 2);
  });

  it('covers both fields — a vector built from only one would still rank', async () => {
    // The failure a rank comparison alone cannot see: if `text` were dropped
    // from the expression, the subject-weighted case above still passes.
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const subjectTerm = `alphaword${unique().slice(0, 8)}`;
    const bodyTerm = `betaword${unique().slice(0, 8)}`;

    const id = await insertMessage({
      userId,
      mailboxId,
      subject: `A ${subjectTerm} here`,
      text: `And a ${bodyTerm} there`,
    });

    const matches = await getDb().execute<{ id: string }>(sql`
      select id from messages
      where id = ${id}
        and search_vector @@ to_tsquery('english', ${`${subjectTerm} & ${bodyTerm}`})
    `);

    expect(matches.map((row) => row.id)).toEqual([id]);
  });

  it('is GENERATED — no write path can make it disagree with the body', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const id = await insertMessage({ userId, mailboxId, subject: 'real subject' });

    const error = await rejection(
      getDb().execute(sql`
        update messages set search_vector = to_tsvector('english', 'a lie') where id = ${id}
      `)
    );

    expect(pgErrorCode(error)).toBe(GENERATED_ALWAYS);
  });

  it('follows an edit to the subject without anyone recomputing it', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const term = `gammaword${unique().slice(0, 8)}`;
    const id = await insertMessage({ userId, mailboxId, subject: 'before' });

    await getDb().update(messages).set({ subject: `now with ${term}` }).where(eq(messages.id, id));

    const matches = await getDb().execute<{ id: string }>(sql`
      select id from messages
      where id = ${id} and search_vector @@ to_tsquery('english', ${term})
    `);
    expect(matches).toHaveLength(1);
  });

  it('is served by a GIN index', async () => {
    const [row] = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'messages_search_vector_idx'
    `);

    expect(row.indexdef).toContain('USING gin');
    expect(row.indexdef).toContain('search_vector');
  });
});

describe('messages — the protected bodies', () => {
  it('protects every column Mongoose marked `select: false`', () => {
    for (const field of MONGOOSE_SELECT_FALSE_MESSAGE_FIELDS) {
      expect([...MESSAGES_PROTECTED_COLUMNS]).toContain(field);
    }
  });

  it('protects the search vector too, and states why that is the only addition', () => {
    // `search_vector` is derived FROM `text` and carries every lexeme with its
    // position, so a guard on the source alone is not a guard. It is the ONLY
    // entry beyond the Mongoose set — anything else appearing here is a
    // decision somebody must justify, not a silent addition.
    const beyondMongoose = MESSAGES_PROTECTED_COLUMNS.filter(
      (column) => !(MONGOOSE_SELECT_FALSE_MESSAGE_FIELDS as readonly string[]).includes(column)
    );

    expect(beyondMongoose).toEqual(['searchVector']);
  });

  it('withholds exactly those columns from publicColumns and nothing else', () => {
    const all = Object.keys(getTableColumns(messages));
    const selectable = new Set(Object.keys(publicColumns(messages, PROTECTED_COLUMNS_BY_TABLE)));

    for (const column of MESSAGES_PROTECTED_COLUMNS) {
      expect(selectable.has(column)).toBe(false);
    }
    const missing = all.filter(
      (name) =>
        !selectable.has(name) && !(MESSAGES_PROTECTED_COLUMNS as readonly string[]).includes(name)
    );
    expect(missing).toEqual([]);
    // The columns a list view is actually built from must survive.
    expect(selectable.has('subject')).toBe(true);
    expect(selectable.has('fromAddress')).toBe(true);
    expect(selectable.has('date')).toBe(true);
  });

  it('really omits them from the returned row, not just the type', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const id = await insertMessage({
      userId,
      mailboxId,
      subject: 'hello',
      text: 'SECRET BODY',
      html: '<p>SECRET BODY</p>',
      encryptedBody: 'SECRET CIPHERTEXT',
      headers: { received: 'from mx.example.com (203.0.113.9)' },
    });

    const [row] = await getDb().select(publicColumns(messages, PROTECTED_COLUMNS_BY_TABLE)).from(messages).where(eq(messages.id, id));
    const serialized = JSON.stringify(row);

    expect(Object.keys(row)).not.toContain('text');
    expect(serialized).not.toContain('SECRET BODY');
    expect(serialized).not.toContain('SECRET CIPHERTEXT');
    expect(serialized).not.toContain('203.0.113.9');
  });

  it('still lets a server-only path name the column explicitly', async () => {
    // Opting in is deliberate and greppable: the inbound-mail path legitimately
    // reads `headers`, which is the ONE sanctioned place third-party SMTP
    // `Received:` IPs are retained.
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const received = 'from mx.example.com (198.51.100.7) by oxy.so';
    const id = await insertMessage({ userId, mailboxId, headers: { received } });

    const [row] = await getDb()
      .select({ id: messages.id, headers: messages.headers })
      .from(messages)
      .where(eq(messages.id, id));

    expect(row.headers.received).toBe(received);
  });
});

describe('message_recipients — one table, a kind discriminator, real order', () => {
  it('rebuilds each header in the order it was written', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const messageId = await insertMessage({ userId, mailboxId });

    await getDb().insert(messageRecipients).values([
      { messageId, kind: 'to', ord: 0, name: 'Ada', address: 'ada@example.com' },
      { messageId, kind: 'to', ord: 1, address: 'grace@example.com' },
      { messageId, kind: 'cc', ord: 0, address: 'alan@example.com' },
      { messageId, kind: 'bcc', ord: 0, address: 'edsger@example.com' },
    ]);

    const to = await getDb()
      .select({ address: messageRecipients.address, name: messageRecipients.name })
      .from(messageRecipients)
      .where(and(eq(messageRecipients.messageId, messageId), eq(messageRecipients.kind, 'to')))
      .orderBy(asc(messageRecipients.ord));

    expect(to).toEqual([
      { address: 'ada@example.com', name: 'Ada' },
      { address: 'grace@example.com', name: null },
    ]);
  });

  it('answers "which messages went to this address" — the read jsonb could not', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const address = `hunted-${unique()}@example.com`;
    const first = await insertMessage({ userId, mailboxId });
    const second = await insertMessage({ userId, mailboxId });

    await getDb().insert(messageRecipients).values([
      { messageId: first, kind: 'to', ord: 0, address },
      { messageId: second, kind: 'bcc', ord: 0, address },
    ]);

    const found = await getDb()
      .select({ messageId: messageRecipients.messageId, kind: messageRecipients.kind })
      .from(messageRecipients)
      .where(eq(messageRecipients.address, address));

    expect(found).toHaveLength(2);
    expect(new Set(found.map((row) => row.kind))).toEqual(new Set(['to', 'bcc']));
  });

  it('keeps the ordering total within one header', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const messageId = await insertMessage({ userId, mailboxId });
    await getDb()
      .insert(messageRecipients)
      .values({ messageId, kind: 'to', ord: 0, address: 'a@example.com' });

    const error = await rejection(
      getDb()
        .insert(messageRecipients)
        .values({ messageId, kind: 'to', ord: 0, address: 'b@example.com' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // …but the same position in a DIFFERENT header is a different recipient.
    await expect(
      getDb()
        .insert(messageRecipients)
        .values({ messageId, kind: 'cc', ord: 0, address: 'b@example.com' })
    ).resolves.toBeDefined();
  });

  it('refuses a kind outside the closed set', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const messageId = await insertMessage({ userId, mailboxId });

    const error = await rejection(
      getDb().execute(sql`
        insert into message_recipients (id, message_id, kind, ord, address)
        values (${unique()}, ${messageId}, 'reply-to', 0, 'x@example.com')
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect([...MESSAGE_RECIPIENT_KINDS]).toEqual(['to', 'cc', 'bcc']);
  });

  it('goes with the message', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const messageId = await insertMessage({ userId, mailboxId });
    await getDb()
      .insert(messageRecipients)
      .values({ messageId, kind: 'to', ord: 0, address: 'a@example.com' });

    await getDb().delete(messages).where(eq(messages.id, messageId));

    const remaining = await getDb()
      .select({ id: messageRecipients.id })
      .from(messageRecipients)
      .where(eq(messageRecipients.messageId, messageId));
    expect(remaining).toEqual([]);
  });
});

describe('message_attachments — the reverse lookup Mongo indexed for', () => {
  it('finds every message referencing one file, scoped to a user', async () => {
    const userId = await owner();
    const other = await owner();
    const mailboxId = await mailbox(userId);
    const otherMailbox = await mailbox(other);

    const [file] = await getDb()
      .insert(files)
      .values({
        sha256: unique(),
        size: 10,
        mime: 'application/pdf',
        ext: 'pdf',
        storageKey: `assets/${unique()}`,
        ownerUserId: userId,
      })
      .returning({ id: files.id });

    const mine = await insertMessage({ userId, mailboxId });
    const theirs = await insertMessage({ userId: other, mailboxId: otherMailbox });
    await getDb().insert(messageAttachments).values([
      {
        messageId: mine,
        ord: 0,
        fileId: file.id,
        name: 'a.pdf',
        contentType: 'application/pdf',
        size: 10,
      },
      {
        messageId: theirs,
        ord: 0,
        fileId: file.id,
        name: 'a.pdf',
        contentType: 'application/pdf',
        size: 10,
      },
    ]);

    const found = await getDb()
      .select({ id: messages.id })
      .from(messageAttachments)
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .where(and(eq(messageAttachments.fileId, file.id), eq(messages.userId, userId)));

    expect(found.map((row) => row.id)).toEqual([mine]);
  });
});

describe('messages — flags, arrays and the extracted card', () => {
  it('stores the six flags as columns with the defaults Mongo declared', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const id = await insertMessage({ userId, mailboxId });

    const [row] = await getDb()
      .select({
        seen: messages.seen,
        starred: messages.starred,
        answered: messages.answered,
        forwarded: messages.forwarded,
        draft: messages.draft,
        pinned: messages.pinned,
      })
      .from(messages)
      .where(eq(messages.id, id));

    expect(row).toEqual({
      seen: false,
      starred: false,
      answered: false,
      forwarded: false,
      draft: false,
      pinned: false,
    });
  });

  it('answers label membership from a native array', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const label = `Shopping-${unique().slice(0, 8)}`;
    const tagged = await insertMessage({ userId, mailboxId, labels: [label, 'Updates'] });
    await insertMessage({ userId, mailboxId, labels: ['Updates'] });

    const found = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, userId), sql`${messages.labels} @> array[${label}]::text[]`));

    expect(found.map((row) => row.id)).toEqual([tagged]);
  });

  it('defaults both arrays to empty, never null — Mongo defaulted to []', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const id = await insertMessage({ userId, mailboxId });

    const [row] = await getDb()
      .select({ labels: messages.labels, references: messages.references })
      .from(messages)
      .where(eq(messages.id, id));

    expect(row.labels).toEqual([]);
    expect(row.references).toEqual([]);
  });

  it('keeps a card whole, or absent', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);

    const id = await insertMessage({
      userId,
      mailboxId,
      cardType: 'purchase',
      cardData: { total: '42.00', currency: 'EUR' },
      cardConfidence: 0.94,
      cardExtractedAt: new Date(),
    });
    const [row] = await getDb()
      .select({ cardType: messages.cardType, cardData: messages.cardData })
      .from(messages)
      .where(eq(messages.id, id));
    expect(row.cardType).toBe('purchase');
    expect(row.cardData).toEqual({ total: '42.00', currency: 'EUR' });

    // Mongo required `type` INSIDE the sub-document, so "a card exists" and
    // "the card has a type" were one statement. Flattened to columns they are
    // two, and the CHECK is what keeps them one.
    const error = await rejection(
      getDb().execute(sql`
        insert into messages (id, user_id, mailbox_id, message_id, from_address, subject, size, date, card_data)
        values (${unique()}, ${userId}, ${mailboxId}, ${unique()}, 'a@b.c', '', 1, now(), '{"total":"1"}'::jsonb)
      `)
    );
    expect(pgConstraint(error)).toBe('messages_card_complete_check');
  });

  it('refuses a negative size — Mongo`s `min: 0`', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);

    const error = await rejection(insertMessage({ userId, mailboxId, size: -1 }));
    expect(pgConstraint(error)).toBe('messages_size_check');
  });
});

describe('mailboxes and the deletes that hang off them', () => {
  it('is unique per user and path, and shared across users', async () => {
    const path = `Projects-${unique()}`;
    const first = await owner();
    await getDb().insert(mailboxes).values({ userId: first, name: 'Projects', path });

    const error = await rejection(
      getDb().insert(mailboxes).values({ userId: first, name: 'Projects', path })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    await expect(
      getDb().insert(mailboxes).values({ userId: await owner(), name: 'Projects', path })
    ).resolves.toBeDefined();
  });

  it('stores no counters — they are computed from messages', async () => {
    // `total_messages`, `unseen_messages` and `size` were denormalized caches
    // maintained by eighteen `$inc` sites. Postgres computes them.
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'mailboxes'
    `);
    const names = columns.map((row) => row.column_name);

    expect(names).not.toContain('total_messages');
    expect(names).not.toContain('unseen_messages');
    expect(names).not.toContain('size');

    const userId = await owner();
    const mailboxId = await mailbox(userId);
    await insertMessage({ userId, mailboxId, seen: true, size: 100 });
    await insertMessage({ userId, mailboxId, seen: false, size: 250 });

    const [stats] = await getDb()
      .select({
        total: sql<number>`count(*)::int`,
        unseen: sql<number>`count(*) filter (where not ${messages.seen})::int`,
        bytes: sql<number>`coalesce(sum(${messages.size}), 0)::int`,
      })
      .from(messages)
      .where(eq(messages.mailboxId, mailboxId));

    expect(stats).toEqual({ total: 2, unseen: 1, bytes: 350 });
  });

  it('deletes a mailbox`s messages with it — what deleteMailbox does by hand', async () => {
    const userId = await owner();
    const mailboxId = await mailbox(userId);
    const messageId = await insertMessage({ userId, mailboxId });

    await getDb().delete(mailboxes).where(eq(mailboxes.id, mailboxId));

    const remaining = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(remaining).toEqual([]);
  });

  it('clears a snooze origin without deleting the snoozed message', async () => {
    // `CASCADE` here would delete the MESSAGE because the folder it used to
    // live in was removed — the message is in a different mailbox entirely.
    const userId = await owner();
    const inbox = await mailbox(userId);
    const snoozeBox = await mailbox(userId);
    const messageId = await insertMessage({
      userId,
      mailboxId: snoozeBox,
      snoozedUntil: new Date(Date.now() + 86_400_000),
      snoozedFromMailbox: inbox,
    });

    await getDb().delete(mailboxes).where(eq(mailboxes.id, inbox));

    const [row] = await getDb()
      .select({ id: messages.id, snoozedFromMailbox: messages.snoozedFromMailbox })
      .from(messages)
      .where(eq(messages.id, messageId));

    expect(row.id).toBe(messageId);
    expect(row.snoozedFromMailbox).toBeNull();
  });
});

describe('messages — the partial indexes that replaced boolean-wide ones', () => {
  it('indexes only the rows the queries actually ask for', async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'messages'
    `);
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    // Mongo indexed BOTH values of each boolean; only one is ever queried.
    expect(byName.get('messages_unseen_idx')).toContain('WHERE');
    expect(byName.get('messages_unseen_idx')).toContain('NOT');
    expect(byName.get('messages_starred_idx')).toContain('WHERE');
    // Mongo's two `sparse` cron indexes.
    expect(byName.get('messages_snoozed_until_idx')).toContain('IS NOT NULL');
    expect(byName.get('messages_scheduled_at_idx')).toContain('IS NOT NULL');
    // The listing index carries the sort every list actually issues.
    expect(byName.get('messages_user_id_mailbox_id_pinned_date_idx')).toContain('pinned');
    // Vacuity floor. A missing index makes `get` return `undefined`, which
    // `toContain` rejects outright — but a broken catalogue query would return
    // nothing at all and this is what catches that.
    expect(rows.length).toBeGreaterThanOrEqual(14);
  });
});
