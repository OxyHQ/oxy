/**
 * Migration 0087's BACKFILL, run against a seeded corpus of messy `birthday`
 * text (see `drizzle/0087_next_green_goblin.sql` for the five formats it
 * tries, the priority order, and the reasoning behind each).
 *
 * The statement executed here is read out of that migration file and run
 * VERBATIM — copying it into this file would test a copy, which the migration
 * could then be edited or regenerated out from under, leaving this suite
 * proving something about SQL that no longer ships.
 *
 * ## Why its own database
 *
 * The backfill is unscoped — it scans every `users` row with a `birthday` and
 * no `date_of_birth` yet, because that is what a migration does. Run against
 * the worker's shared database it would also see whatever other suites left
 * behind, and this suite's assertions are about EXACT parsed values, not
 * counts, so a stray row from another test seeding a `birthday` would not
 * fail loudly — it would just be a row nobody is looking at, which is a worse
 * failure mode than the shared-database contamination this mirrors
 * (`devicePrincipalsBackfill.test.ts`) exists to avoid. The database is
 * created, migrated, seeded and dropped by this file alone.
 *
 * ## The corpus
 *
 * One row per class of input the backfill can meet: each of the five accepted
 * formats, the ambiguous numeric shape it must REJECT, invalid calendar dates
 * (`2024-02-30`, a non-leap `2021-02-29`), out-of-range years, and the
 * shapes it deliberately does not attempt (two-digit years, a bare year, a JS
 * `Date.prototype.toString()`). Every one of these is a `null` OR a specific
 * expected date — never "something", which is the failure mode a looser
 * assertion would hide.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { DATABASE_CASING } from '@oxy.so/db';
import * as schema from '../index';
import { createTestDatabase, dropTestDatabase } from '../../testDatabase';
import { users } from '../users';

const MIGRATION = join(__dirname, '..', '..', '..', '..', 'drizzle', '0087_next_green_goblin.sql');

/**
 * The one data statement in this migration, in file order. A vacuity floor
 * rather than a lower bound: this suite asserts on the effect of it, so a
 * statement appearing, disappearing or splitting has to be a deliberate edit
 * here too.
 */
const BACKFILL_STATEMENT_COUNT = 1;

/** The statement of the migration that writes DATA rather than DDL. */
function backfillStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .filter((chunk) => {
      // Classify on the code, execute the whole chunk: the comments above each
      // statement are part of what ships and Postgres is happy to receive them.
      const code = chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      return code.startsWith('WITH ');
    })
    .map((chunk) => chunk.trim());
}

let databaseUrl: string;
let sql: Sql;
/**
 * Seeds go through drizzle, reads through the raw client.
 *
 * `users` has half a dozen application-supplied defaults (`id`, `color`, ...)
 * that a raw `INSERT` would have to enumerate and then keep in step with the
 * schema forever. The BACKFILL is still raw SQL out of the migration file —
 * that is the thing under test.
 */
let db: PostgresJsDatabase<typeof schema>;

/** A `users` row carrying `birthday`, returning its id. */
async function seedBirthday(birthday: string | null): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ kind: 'personal', birthday })
    .returning({ id: users.id });
  return row.id;
}

/**
 * `::text`, not the bare column: `postgres` (the driver) parses a `date`
 * column into a JS `Date` at UTC midnight, and comparing THAT against a plain
 * `'1990-05-14'` string would silently pass or fail on timezone conversion
 * rather than on what the backfill actually wrote. Casting in SQL sidesteps
 * the driver's own date handling entirely.
 */
async function dateOfBirthOf(id: string): Promise<string | null> {
  const [row] = await sql<Array<{ date_of_birth: string | null }>>`
    select date_of_birth::text from users where id = ${id}
  `;
  return row.date_of_birth;
}

/**
 * The corpus: `birthday` text → the `date_of_birth` the backfill must produce,
 * or `null` when it must decline rather than guess. Grouped by which of the
 * migration's five formats (or none of them) applies.
 */
const CORPUS: ReadonlyArray<{
  readonly description: string;
  readonly birthday: string;
  readonly expected: string | null;
}> = [
  // --- priority 1: ISO 8601, YYYY-MM-DD -------------------------------------
  { description: 'a plain ISO date', birthday: '1990-05-14', expected: '1990-05-14' },
  {
    description: 'an ISO datetime with a time and zone component',
    birthday: '1990-05-14T00:00:00.000Z',
    expected: '1990-05-14',
  },
  {
    description: 'a leap-year 29 February, ISO',
    birthday: '2020-02-29',
    expected: '2020-02-29',
  },

  // --- priority 2: YYYY/MM/DD -------------------------------------------------
  { description: 'year-first with slash separators', birthday: '1990/05/14', expected: '1990-05-14' },

  // --- priority 3: named month, month-first -----------------------------------
  { description: 'full month name, month-first, with a comma', birthday: 'March 4, 1990', expected: '1990-03-04' },
  { description: 'abbreviated month name, month-first, no comma', birthday: 'Mar 4 1990', expected: '1990-03-04' },
  {
    description: 'abbreviated month with a period and an ordinal day suffix',
    birthday: 'Jan. 4th, 1990',
    expected: '1990-01-04',
  },
  {
    description: 'the four-letter "Sept" abbreviation',
    birthday: 'Sept 9, 1990',
    expected: '1990-09-09',
  },

  // --- priority 4: named month, day-first -------------------------------------
  { description: 'day-first with a full month name', birthday: '4 March 1990', expected: '1990-03-04' },
  {
    description: 'day-first with an ordinal suffix, abbreviated month, and a comma',
    birthday: '4th Mar, 1990',
    expected: '1990-03-04',
  },

  // --- priority 5: all-numeric, year last, ONLY when unambiguous -------------
  {
    description: 'numeric with the first part over 12 — can only be the day',
    birthday: '14/05/1990',
    expected: '1990-05-14',
  },
  {
    description: 'numeric with the second part over 12 — can only be the day',
    birthday: '05/14/1990',
    expected: '1990-05-14',
  },
  {
    description: 'numeric where both readings agree (day = month)',
    birthday: '05/05/1990',
    expected: '1990-05-05',
  },
  {
    description: 'numeric with dot separators, unambiguous',
    birthday: '14.05.1990',
    expected: '1990-05-14',
  },
  {
    description: 'numeric with dash separators, unambiguous, day first',
    birthday: '25-12-1990',
    expected: '1990-12-25',
  },
  {
    description: 'GENUINELY AMBIGUOUS numeric — both parts 12 or under and unequal — REJECTED',
    birthday: '03/04/2005',
    expected: null,
  },
  {
    description: 'mismatched separators either side — not one recognised numeric shape',
    birthday: '03/04-2005',
    expected: null,
  },

  // --- rejected: syntactically matched but not a real calendar date ----------
  { description: 'February 30th does not exist', birthday: '1990-02-30', expected: null },
  { description: '29 February in a non-leap year does not exist', birthday: '2021-02-29', expected: null },
  { description: 'month 13 does not exist', birthday: '1990-13-01', expected: null },

  // --- rejected: out of the plausible human-lifetime bound --------------------
  { description: 'a year before 1900', birthday: '1899-05-14', expected: null },
  { description: 'a year after the current one', birthday: '2099-05-14', expected: null },

  // --- rejected: formats deliberately NOT attempted ---------------------------
  { description: 'a two-digit year — which century is not decidable', birthday: '05/14/90', expected: null },
  { description: 'a bare year with no month or day', birthday: '1990', expected: null },
  {
    description: "JS Date.prototype.toString()'s long locale-dependent form",
    birthday: 'Mon May 14 1990 00:00:00 GMT+0000 (Coordinated Universal Time)',
    expected: null,
  },
  { description: 'unrecognisable free text', birthday: 'not a date', expected: null },
  { description: 'an empty string', birthday: '', expected: null },
  { description: 'whitespace only', birthday: '   ', expected: null },
];

const ids: Record<string, string> = {};
let nullBirthdayId: string;

beforeAll(async () => {
  databaseUrl = await createTestDatabase({ assignEnv: false });
  sql = postgres(databaseUrl, { max: 1 });
  db = drizzle(sql, { schema, casing: DATABASE_CASING });

  for (const entry of CORPUS) {
    ids[entry.description] = await seedBirthday(entry.birthday);
  }
  // The positive control for the `birthday IS NOT NULL` guard: a row with no
  // birthday at all must be left alone, not crash the scan.
  nullBirthdayId = await seedBirthday(null);

  const statements = backfillStatements();
  if (statements.length !== BACKFILL_STATEMENT_COUNT) {
    throw new Error(
      `Expected ${BACKFILL_STATEMENT_COUNT} data statement(s) in 0087, found ${statements.length}. ` +
        'Either the migration changed or the classifier stopped recognising it — ' +
        'a suite that runs zero statements passes by examining nothing.'
    );
  }
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (databaseUrl) await dropTestDatabase(databaseUrl);
}, 60_000);

describe.each(CORPUS)('$description ($birthday)', ({ description, expected }) => {
  it(expected === null ? 'is left NULL rather than guessed' : `parses to ${expected}`, async () => {
    expect(await dateOfBirthOf(ids[description])).toBe(expected);
  });
});

describe('a row with no birthday at all', () => {
  it('is left alone', async () => {
    expect(await dateOfBirthOf(nullBirthdayId)).toBeNull();
  });
});

describe('the corpus as a whole', () => {
  it('parsed exactly the entries with a defined expectation, nothing more and nothing less', async () => {
    const expectedParsedCount = CORPUS.filter((entry) => entry.expected !== null).length;
    const [{ count }] = await sql<Array<{ count: number }>>`
      select count(*)::int as count
        from users
       where id = any(${Object.values(ids)})
         and date_of_birth is not null
    `;
    expect(count).toBe(expectedParsedCount);
  });
});
