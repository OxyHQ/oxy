/**
 * The four `user_id`-led `messages` indexes (migration 0192) exist, are valid,
 * and can serve the reads they were built for.
 *
 * Same method as `peopleSearchIndexes.test.ts`: the invariant is "a plan using
 * this index EXISTS", asserted by switching the alternatives off rather than by
 * seeding a corpus big enough to sway the planner, so a small test database
 * cannot make it flake.
 *
 * - The two b-trees are the only indexes that deliver the `pinned, date, id`
 *   and `date, id` orders (`DESC NULLS LAST`, as the index is built), so with
 *   `enable_sort = off` a plan without a Sort node has to read one of them.
 * - The two GIN indexes compete with every b-tree that leads with `user_id`,
 *   which on an empty table the planner rightly prefers. So every OTHER index
 *   on `messages` is dropped inside a transaction that is rolled back, and the
 *   plan shows whether the scoped index answers `user_id` AND the term as index
 *   conditions on its own.
 */

import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { REQUIRED_EXTENSIONS } from '../extensions';

const SCOPED_INDEXES = [
  'messages_user_id_mailbox_id_pinned_date_id_idx',
  'messages_user_id_date_id_idx',
  'messages_user_id_search_vector_idx',
  'messages_user_id_labels_idx',
] as const;

/** Thrown to roll a test transaction back once its plan has been read. */
class RolledBack extends Error {
  constructor(readonly plan: string) {
    super('rolled back');
  }
}

/** `EXPLAIN` a statement in a transaction that is always rolled back. */
async function planOf(setup: string[], statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await getDb().transaction(async (tx) => {
      for (const line of setup) await tx.execute(sql.raw(line));
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${statement}`);
      throw new RolledBack(rows.map((row) => row['QUERY PLAN']).join('\n'));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.plan;
    throw error;
  }
  throw new Error('unreachable: the transaction always throws');
}

/** Drop every `messages` index but `keep` and the primary key — rolled back with the test. */
function dropAllIndexesBut(keep: string): string {
  return `do $$
    declare name text;
    begin
      for name in
        select c.relname from pg_index i
        join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'messages'::regclass and not i.indisprimary and c.relname <> '${keep}'
      loop
        execute format('drop index %I', name);
      end loop;
    end $$`;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('btree_gin is a declared prerequisite', () => {
  it('is registered with a reason naming the indexes that need it', () => {
    const entry = REQUIRED_EXTENSIONS.find((extension) => extension.name === 'btree_gin');
    expect(entry?.reason).toContain('messages_user_id_search_vector_idx');
    expect(entry?.reason).toContain('messages_user_id_labels_idx');
  });

  it('is installed in the database the migrations ran against', async () => {
    const rows = await getDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'btree_gin'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('the user-scoped messages indexes', () => {
  it('exist, valid, with user_id as their leading key', async () => {
    const rows = await getDb().execute<{ relname: string; valid: boolean; definition: string }>(sql`
      select c.relname, i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname in (${sql.join(
        SCOPED_INDEXES.map((name) => sql`${name}`),
        sql`, `,
      )})
    `);
    const byName = new Map(rows.map((row) => [row.relname, row]));

    for (const name of SCOPED_INDEXES) {
      expect(byName.get(name)?.valid).toBe(true);
      expect(byName.get(name)?.definition).toMatch(/\(user_id,/);
    }
    expect(byName.get('messages_user_id_mailbox_id_pinned_date_id_idx')?.definition).toContain(
      'id DESC NULLS LAST)',
    );
    expect(byName.get('messages_user_id_search_vector_idx')?.definition).toContain('USING gin');
    expect(byName.get('messages_user_id_labels_idx')?.definition).toContain('USING gin');
  });

  it('serves a folder page in pinned, date, id order without sorting', async () => {
    const plan = await planOf(
      ['set local enable_sort = off', 'set local enable_seqscan = off'],
      sql`select id from messages
          where user_id = 'u' and mailbox_id = 'm'
          order by pinned desc nulls last, date desc nulls last, id desc nulls last
          limit 51`,
    );
    expect(plan).toContain('messages_user_id_mailbox_id_pinned_date_id_idx');
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('serves a queryless search in date, id order without sorting', async () => {
    const plan = await planOf(
      ['set local enable_sort = off', 'set local enable_seqscan = off'],
      sql`select id from messages
          where user_id = 'u'
          order by date desc nulls last, id desc nulls last
          limit 51`,
    );
    expect(plan).toContain('messages_user_id_date_id_idx');
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('answers a text search for one owner from the scoped GIN index', async () => {
    const plan = await planOf(
      ['set local enable_seqscan = off', dropAllIndexesBut('messages_user_id_search_vector_idx')],
      sql`select id from messages
          where user_id = 'u' and search_vector @@ websearch_to_tsquery('english', 'invoice')`,
    );
    expect(plan).toContain('messages_user_id_search_vector_idx');
    // Both keys are index conditions, not one condition and a filter.
    expect(plan).toMatch(/Index Cond: \(\(user_id = 'u'::text\) AND \(search_vector @@/);
  });

  it('answers a label view for one owner from the scoped GIN index', async () => {
    const plan = await planOf(
      ['set local enable_seqscan = off', dropAllIndexesBut('messages_user_id_labels_idx')],
      sql`select id from messages where user_id = 'u' and labels @> array['work']::text[]`,
    );
    expect(plan).toContain('messages_user_id_labels_idx');
    expect(plan).toMatch(/Index Cond: \(\(user_id = 'u'::text\) AND \(labels @>/);
  });
});
