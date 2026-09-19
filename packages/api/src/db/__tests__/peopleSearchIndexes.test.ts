/**
 * People search must be index-servable, and must stay that way.
 *
 * `peopleSearchMatch` is four OR-ed leading-wildcard `ILIKE '%term%'` tests. No
 * b-tree and no `tsvector` can answer a substring question, so until
 * `users_people_search_trgm_idx` existed every people search — the query behind
 * a search box, fired as the user types — read the whole `users` table.
 *
 * Three independent things are held here, and they fail for different reasons
 * on purpose:
 *
 * 1. **`pg_trgm` is present before any migration needs it**, i.e. the
 *    `REQUIRED_EXTENSIONS` registry really is applied ahead of the migrations.
 *    Same shape as the PostGIS half of `postgis.test.ts`, for the same reason.
 * 2. **The plan uses the index.** Asserted with `enable_seqscan = off` rather
 *    than by seeding a large corpus: the invariant is "a plan using this index
 *    EXISTS", which is size-independent, so a small test database cannot make
 *    it flake. On a table of ten rows the planner would correctly prefer a
 *    sequential scan, and a test that seeded enough rows to change its mind
 *    would be slow and still only probabilistically right.
 * 3. **The index expression still matches the predicate.** This is the one that
 *    earns its keep long-term. `PEOPLE_SEARCH_TRGM_EXPRESSION` is read FROM the
 *    schema and asserted against the catalogue's own `indexdef`, so adding a
 *    fifth searched column to `peopleSearchMatch` without extending the index
 *    fails here — instead of silently restoring the sequential scan, which no
 *    functional test can see because the answers stay correct.
 */

import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { REQUIRED_EXTENSIONS } from '../extensions';
import { PEOPLE_SEARCH_TRGM_EXPRESSION, users } from '../schema/users';
import {
  MIN_FUZZY_TERM_LENGTH,
  peopleSearchMatch,
  peopleSearchPredicate,
} from '../../utils/profileQuery';

const TRGM_INDEX = 'users_people_search_trgm_idx';
const PREFIX_INDEXES = [
  'users_lower_username_prefix_idx',
  'users_lower_name_first_prefix_idx',
  'users_lower_name_last_prefix_idx',
];

/** Collapse whitespace so a formatting difference is not a failure. */
function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The `users` columns a SQL string references.
 *
 * The candidate set is EVERY column of `users`, read from the table object —
 * deliberately not a hand-written list of the four that people search uses
 * today. A list of expected columns cannot detect a FIFTH one being added,
 * because the new column is not in the list to be looked for: the first version
 * of this helper did exactly that, and a mutation adding `email` to the
 * predicate passed all ten tests. The gate has to be able to see a column
 * nobody told it about, or it is only checking its own assumptions.
 *
 * Matched on word boundaries, since `name` is a prefix of `name_first` and a
 * substring test would report a column the SQL never mentions.
 */
const USERS_COLUMNS: readonly string[] = Object.values(getTableConfig(users).columns).map(
  (column) => sqlColumnName(column)
);

function peopleSearchColumnsIn(sqlText: string): Set<string> {
  const text = sqlText.toLowerCase();
  return new Set(
    USERS_COLUMNS.filter((column) => new RegExp(`\\b${column}\\b`).test(text))
  );
}

async function explain(predicate: ReturnType<typeof peopleSearchMatch>): Promise<string> {
  // `enable_seqscan = off` is LOCAL to this transaction, so it cannot leak into
  // another test's plans.
  const rows = await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    return tx.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select ${sql.raw('id')} from users where ${predicate}`
    );
  });
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('pg_trgm is a declared prerequisite', () => {
  it('is registered with a reason, not added ad hoc', () => {
    const entry = REQUIRED_EXTENSIONS.find((extension) => extension.name === 'pg_trgm');
    expect(entry).toBeDefined();
    expect(entry?.reason).toMatch(/gin_trgm_ops/);
  });

  it('is installed in the database the migrations ran against', async () => {
    const rows = await getDb().execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'pg_trgm'`
    );
    expect(rows).toHaveLength(1);
  });
});

describe('the people-search indexes exist as declared', () => {
  it('builds the trigram index as a GIN over gin_trgm_ops', async () => {
    const rows = await getDb().execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'users' and indexname = ${TRGM_INDEX}`
    );
    expect(rows).toHaveLength(1);
    const definition = normalizeSql(rows[0].indexdef);
    expect(definition).toContain('using gin');
    expect(definition).toContain('gin_trgm_ops');
  });

  it('covers every column the predicate filters on', async () => {
    const rows = await getDb().execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'users' and indexname = ${TRGM_INDEX}`
    );

    // Compared as SETS OF COLUMNS, not as text. Postgres rewrites an index
    // expression when it stores it — `''` becomes `''::text`, and `a || b || c`
    // comes back fully parenthesised — so a literal substring assertion against
    // `PEOPLE_SEARCH_TRGM_EXPRESSION` fails on formatting alone and would have
    // to be loosened until it stopped testing anything. The invariant that
    // actually matters is narrower and stable: every column the predicate
    // filters on is a column the index covers.
    const indexed = peopleSearchColumnsIn(rows[0].indexdef);
    const filtered = peopleSearchColumnsIn(
      getDb().dialect.sqlToQuery(peopleSearchMatch('needle')).sql
    );

    expect(filtered.size).toBeGreaterThan(0);
    // A fifth searched column added to `peopleSearchMatch` and not to the index
    // fails HERE. Without this the search would keep returning correct answers
    // while quietly going back to a sequential scan — a regression no
    // functional test can see, because only the latency changes.
    expect([...filtered].filter((column) => !indexed.has(column))).toEqual([]);
    // ...and the converse: an index column the predicate no longer uses is
    // write amplification nobody is paying for on purpose.
    expect([...indexed].filter((column) => !filtered.has(column))).toEqual([]);
  });

  it('is built on the expression the schema declares, not a hand-copied one', async () => {
    // The columns above prove coverage; this proves the shape. Both halves of
    // the expression matter: the single-space separators are what make the
    // coarse filter a strict superset of the four ILIKEs.
    const rows = await getDb().execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'users' and indexname = ${TRGM_INDEX}`
    );
    const declared = normalizeSql(getDb().dialect.sqlToQuery(PEOPLE_SEARCH_TRGM_EXPRESSION).sql);
    const stored = normalizeSql(rows[0].indexdef);

    // Strip what Postgres adds when it stores an expression: explicit `::text`
    // casts, and the parentheses it inserts around every binary operator.
    const shape = (value: string): string =>
      value.replace(/::text/g, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

    expect(shape(stored)).toContain(shape(declared));
  });

  it('builds the short-term prefix indexes with text_pattern_ops', async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where tablename = 'users'`
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
    for (const name of PREFIX_INDEXES) {
      expect(byName.has(name)).toBe(true);
      // `text_pattern_ops` is not decoration: under a non-C collation a plain
      // b-tree cannot answer `LIKE 'ab%'` at all.
      expect(normalizeSql(byName.get(name) ?? '')).toContain('text_pattern_ops');
    }
  });
});

describe('the people-search predicate is index-servable', () => {
  it('reaches the trigram index for an ordinary term, with no sequential scan', async () => {
    const plan = await explain(peopleSearchMatch('alice'));
    expect(plan).toContain(TRGM_INDEX);
    expect(plan).not.toContain('Seq Scan on users');
  });

  it('reaches a prefix index for a term below the trigram floor', async () => {
    // `pg_trgm` extracts no trigrams from `%ab%`, so without the prefix branch
    // the cheapest query to issue would be the most expensive to serve.
    expect(MIN_FUZZY_TERM_LENGTH).toBe(3);
    const plan = await explain(peopleSearchMatch('ab'));
    expect(PREFIX_INDEXES.some((name) => plan.includes(name))).toBe(true);
    expect(plan).not.toContain('Seq Scan on users');
  });

  it('is index-servable together with the eligibility gate, as the routes use it', async () => {
    // The routes never apply the match alone; a plan that only works without
    // the gate would not be the plan production runs.
    const plan = await explain(
      sql`${peopleSearchPredicate()} and ${peopleSearchMatch('alice')}` as never
    );
    expect(plan).toContain(TRGM_INDEX);
  });
});

describe('the coarse prefilter does not become the predicate', () => {
  it('keeps the exact ILIKE recheck, so a cross-field match is refused', async () => {
    // The indexed expression joins the columns with single spaces, so
    // `"alice bob"` matches the CONCATENATION of first name `alice` and last
    // name `bob` while matching no single column. The prefilter admits that row
    // and the exact clauses must reject it.
    //
    // This is the assertion that stops the tempting "simplification" of
    // dropping the recheck and trusting the index: that change would keep every
    // other test in this file green while quietly widening every search result.
    // Partial values, letting the schema's own defaults supply the rest — the
    // same shape `profilesSearch.test.ts` seeds with.
    const [seeded] = await getDb()
      .insert(users)
      .values({ username: 'aliceb', nameFirst: 'alice', nameLast: 'bob' })
      .returning({ id: users.id });

    try {
      const rows = await getDb().execute<{ id: string }>(
        sql`select id from users where ${peopleSearchMatch('alice bob')}`
      );
      expect(rows.map((row) => row.id)).not.toContain(seeded.id);

      // ...and the same row IS found by a term that genuinely occurs in a column.
      const found = await getDb().execute<{ id: string }>(
        sql`select id from users where ${peopleSearchMatch('aliceb')}`
      );
      expect(found.map((row) => row.id)).toContain(seeded.id);
    } finally {
      await getDb().delete(users).where(eq(users.id, seeded.id));
    }
  });
});
