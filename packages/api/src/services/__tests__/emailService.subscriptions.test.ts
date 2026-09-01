/**
 * The subscriptions rollup, against a REAL Postgres.
 *
 * Mongo's `$group` + `$match` + `$sort` + `$facet` becomes one grouped CTE used
 * by two statements. The part that is easy to get wrong and impossible to see:
 *
 * **The `address asc` tiebreak is load-bearing.** `order by message_count desc`
 * alone is not a total order, so two senders with equal counts may land either
 * side of the page boundary on two different executions — the same sender comes
 * back on both pages while another is never returned at all. The pagination
 * test below builds exactly that shape (five senders, identical counts) and
 * asserts the union of two pages is the whole set with no repeats. Removing the
 * tiebreak does not reliably fail a single-page assertion, which is why the
 * test paginates.
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
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

/** Mongo's `{ messageCount: { $gte: 3 } }` — a sender under this never appears. */
const SUBSCRIPTION_MIN_MESSAGES = 3;

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function folder(userId: string, specialUse: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: specialUse, path: `${specialUse}-${unique()}`, specialUse })
    .returning({ id: mailboxes.id });
  return row.id;
}

async function store(
  userId: string,
  mailboxId: string,
  values: {
    fromAddress: string;
    fromName?: string | null;
    seen?: boolean;
    date?: Date;
    headers?: Record<string, string>;
  },
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: values.fromAddress,
      fromName: values.fromName ?? null,
      subject: '',
      size: 10,
      seen: values.seen ?? false,
      headers: values.headers ?? {},
      date: values.date ?? new Date(),
    })
    .returning({ id: messages.id });
  return row.id;
}

/** `count` messages from one sender, newest last. */
async function sender(
  userId: string,
  mailboxId: string,
  address: string,
  count: number,
  extra: { seenCount?: number; headers?: Record<string, string>; names?: string[] } = {},
): Promise<void> {
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    await store(userId, mailboxId, {
      fromAddress: address,
      fromName: extra.names?.[i] ?? null,
      seen: i < (extra.seenCount ?? 0),
      date: new Date(base + i * 60_000),
      // Only the newest message's headers are read, so they go on the last one.
      headers: i === count - 1 ? extra.headers : undefined,
    });
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getSubscriptions — the rollup', () => {
  it('groups by sender and reports counts, dates and the latest message', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const address = `news-${unique()}@example.com`;

    await sender(userId, inbox, address, 4, {
      seenCount: 2,
      names: ['Old Name', 'Old Name', 'Old Name', 'Current Name'],
    });

    const { data, total } = await emailService.getSubscriptions(userId);

    expect(total).toBe(1);
    expect(data).toHaveLength(1);
    expect(data[0]._id).toBe(address);
    expect(data[0].messageCount).toBe(4);
    expect(data[0].readCount).toBe(2);
    // `$first` after `{$sort: {date: -1}}` took the NEWEST message's name.
    expect(data[0].name).toBe('Current Name');
    expect(data[0].latestDate.getTime()).toBeGreaterThan(data[0].oldestDate.getTime());
  });

  it('drops a sender below the three-message floor', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const rare = `rare-${unique()}@example.com`;
    const frequent = `frequent-${unique()}@example.com`;

    await sender(userId, inbox, rare, SUBSCRIPTION_MIN_MESSAGES - 1);
    await sender(userId, inbox, frequent, SUBSCRIPTION_MIN_MESSAGES);

    const { data } = await emailService.getSubscriptions(userId);
    expect(data.map((s) => s._id)).toEqual([frequent]);
  });

  it('falls back to the address local part when no display name was ever sent', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const local = `bare-${unique()}`;

    await sender(userId, inbox, `${local}@example.com`, 3);

    const { data } = await emailService.getSubscriptions(userId);
    expect(data[0].name).toBe(local);
  });

  it('reads only received mail — Sent and Trash are not subscriptions', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const archive = await folder(userId, '\\Archive');
    const sent = await folder(userId, '\\Sent');
    const inboxSender = `in-${unique()}@example.com`;
    const archiveSender = `arch-${unique()}@example.com`;
    const sentSender = `out-${unique()}@example.com`;

    await sender(userId, inbox, inboxSender, 3);
    await sender(userId, archive, archiveSender, 3);
    await sender(userId, sent, sentSender, 3);

    const { data } = await emailService.getSubscriptions(userId);
    expect(new Set(data.map((s) => s._id))).toEqual(new Set([inboxSender, archiveSender]));
  });

  it('classifies by List-Unsubscribe, then by sender pattern, then frequency', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const withHeader = `letters-${unique()}@example.com`;
    const patterned = `noreply-${unique()}@example.com`;
    const plain = `colleague-${unique()}@example.com`;

    await sender(userId, inbox, withHeader, 3, {
      headers: { 'list-unsubscribe': '<https://example.com/unsub>' },
    });
    await sender(userId, inbox, patterned, 3);
    await sender(userId, inbox, plain, 3);

    const { data } = await emailService.getSubscriptions(userId);
    const byAddress = new Map(data.map((s) => [s._id, s]));

    expect(byAddress.get(withHeader)?.type).toBe('list-unsubscribe');
    expect(byAddress.get(withHeader)?.hasListUnsubscribe).toBe(true);
    expect(byAddress.get(patterned)?.type).toBe('pattern-match');
    expect(byAddress.get(plain)?.type).toBe('frequent');
    expect(byAddress.get(plain)?.hasListUnsubscribe).toBe(false);
  });

  it('reads the header off the LATEST message, not an arbitrary one', async () => {
    // `latest_message_id` is picked with an explicit `order by date desc, id desc`
    // inside `array_agg`; Mongo's `$first` after a date-only sort was ambiguous
    // on ties. An older message carrying the header must not classify the sender.
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const address = `switched-${unique()}@example.com`;
    const base = Date.UTC(2026, 0, 1);

    await store(userId, inbox, {
      fromAddress: address,
      date: new Date(base),
      headers: { 'list-unsubscribe': '<https://example.com/old>' },
    });
    await store(userId, inbox, { fromAddress: address, date: new Date(base + 1000) });
    await store(userId, inbox, { fromAddress: address, date: new Date(base + 2000) });

    const { data } = await emailService.getSubscriptions(userId);
    expect(data[0].hasListUnsubscribe).toBe(false);
    expect(data[0].type).toBe('frequent');
  });

  it('reports a total independent of the page, including past the end', async () => {
    // `$facet` computed the total separately from the page. A window
    // `count(*) over ()` looks equivalent and silently loses the total for an
    // empty page, which is exactly when a client still needs it to stop paging.
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    for (let i = 0; i < 3; i++) {
      await sender(userId, inbox, `s${i}-${unique()}@example.com`, 3);
    }

    const first = await emailService.getSubscriptions(userId, { limit: 2, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.data).toHaveLength(2);

    const past = await emailService.getSubscriptions(userId, { limit: 2, offset: 99 });
    expect(past.data).toHaveLength(0);
    expect(past.total).toBe(3);
  });
});

/**
 * The `address asc` tiebreak.
 *
 * ## Read this before trusting these three as a guard — they are NOT one
 *
 * Removing `, address asc` from the service leaves all three GREEN. That was
 * measured, not assumed, and the reason is worth writing down so nobody adds a
 * fourth case believing it closes the hole.
 *
 * The grouping key IS the address, and `messages_user_id_from_address_date_idx`
 * leads with `(user_id, from_address)` — so for a per-user query Postgres takes
 * a `GroupAggregate` fed by that index and emits the groups in ADDRESS ORDER
 * for free. The outer sort on `message_count desc` then happens to preserve it.
 * The ordering the tiebreak asks for is the ordering the plan was going to
 * produce anyway.
 *
 * It is observable — but only when the plan flips. With fresh statistics on a
 * SMALL table the same query hash-aggregates and the output order becomes hash
 * order (verified on PostgreSQL 17.5 at 400 senders: `HashAggregate` over a
 * `Seq Scan`, output not sorted). Reproducing that inside this suite would mean
 * seeding hundreds of rows AND running `analyze`, and it would still pass or
 * fail depending on how much unrelated data the other suites had put in the
 * shared database first — a check whose ability to fail depends on the
 * planner's mood is worse than an honest one that documents the contract.
 *
 * So these three state the intended order (and do catch a REVERSED or
 * count-less `order by`), and the tiebreak itself stands on the SQL contract:
 * without a strict total order Postgres promises nothing, and a plan change —
 * a parallel aggregate, a dropped index, a version upgrade — is free to start
 * returning one sender on both pages and another on neither.
 */
describe('getSubscriptions — the tiebreak that makes pagination stable', () => {
  it('returns every sender exactly once across two pages when counts are equal', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const addresses = Array.from({ length: 5 }, (_unused, i) => `tie-${i}-${unique()}@example.com`);
    for (const address of addresses) {
      await sender(userId, inbox, address, SUBSCRIPTION_MIN_MESSAGES);
    }

    const first = await emailService.getSubscriptions(userId, { limit: 3, offset: 0 });
    const second = await emailService.getSubscriptions(userId, { limit: 3, offset: 3 });
    const paged = [...first.data, ...second.data].map((s) => s._id);

    expect(first.total).toBe(5);
    expect(paged).toHaveLength(5);
    expect(new Set(paged).size).toBe(5);
    expect(paged.slice().sort()).toEqual(addresses.slice().sort());
  });

  it('orders equal-count senders by address, and repeats that order exactly', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const suffix = unique();
    const addresses = ['c', 'a', 'b'].map((letter) => `${letter}-${suffix}@example.com`);
    for (const address of addresses) {
      await sender(userId, inbox, address, SUBSCRIPTION_MIN_MESSAGES);
    }

    const expected = addresses.slice().sort();
    for (let run = 0; run < 3; run++) {
      const { data } = await emailService.getSubscriptions(userId);
      expect(data.map((s) => s._id)).toEqual(expected);
    }
  });

  it('still ranks by count first — the address only breaks a tie', async () => {
    const userId = await owner();
    const inbox = await folder(userId, '\\Inbox');
    const suffix = unique();
    const busiest = `z-${suffix}@example.com`;
    const quieter = `a-${suffix}@example.com`;

    await sender(userId, inbox, busiest, 6);
    await sender(userId, inbox, quieter, 3);

    const { data } = await emailService.getSubscriptions(userId);
    expect(data.map((s) => s._id)).toEqual([busiest, quieter]);
  });
});
