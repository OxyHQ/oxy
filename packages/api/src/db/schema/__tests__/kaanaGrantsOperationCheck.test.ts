/**
 * `kaana_grants_operation_check` against a REAL Postgres: the migrated CHECK
 * (0162, widened by 0254) accepts every operation `grantOperationSchema` names
 * (`rerank` last) and refuses anything else. A grant Oxy signs for an operation
 * the table cannot store would fail at insert, after the hold was taken.
 *
 * The probe row is built from the live catalog (every NOT NULL column, the copy keeping no
 * default, so it does not depend on the table's shape.
 */
import { grantOperationSchema } from '@kaana.ai/contracts/internal';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { KAANA_GRANT_OPERATIONS } from '../kaanaGrants';

const CHECK = 'kaana_grants_operation_check';

const FILLERS: Readonly<Record<string, string>> = {
  text: "'probe'",
  uuid: 'gen_random_uuid()',
  numeric: '0',
  smallint: '0',
  integer: '0',
  bigint: '0',
  boolean: 'false',
  'timestamp with time zone': 'now()',
  jsonb: "'{}'::jsonb",
};

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The error an insert of one row naming `operation` raises, or `undefined`. The
 * row goes into a temporary copy of the table that keeps only the operation CHECK
 * (as migrated, via `LIKE ... INCLUDING CONSTRAINTS`), so no other constraint
 * can answer for it and no foreign key needs a parent row.
 */
async function insertViolation(
  operation: string,
): Promise<{ code?: string; constraint_name?: string } | undefined> {
  const db = getDb();
  const columns = (await db.execute(sql`
    select column_name, data_type from information_schema.columns
    where table_schema = current_schema() and table_name = 'kaana_grants'
      and is_nullable = 'NO' and is_generated = 'NEVER'
    order by ordinal_position`)) as unknown as { column_name: string; data_type: string }[];
  const names = columns.map((column) => `"${column.column_name}"`);
  const values = columns.map((column) =>
    column.column_name === 'operation'
      ? `'${operation}'`
      : (FILLERS[column.data_type] ?? `'probe'`),
  );
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          'create temp table kaana_grants_probe (like kaana_grants including constraints) on commit drop',
        ),
      );
      const others = (await tx.execute(sql`
        select conname from pg_constraint
        where conrelid = 'kaana_grants_probe'::regclass and contype = 'c' and conname <> ${CHECK}`)) as unknown as {
        conname: string;
      }[];
      for (const { conname } of others) {
        await tx.execute(sql.raw(`alter table kaana_grants_probe drop constraint "${conname}"`));
      }
      await tx.execute(
        sql.raw(
          `insert into kaana_grants_probe (${names.join(', ')}) values (${values.join(', ')})`,
        ),
      );
    });
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    return cause as { code?: string; constraint_name?: string };
  }
}

describe('kaana_grants_operation_check', () => {
  it('lists every operation the grant contract names, last one included', async () => {
    const [row] = (await getDb().execute(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint where conname = ${CHECK}`)) as unknown as {
      definition: string;
    }[];
    for (const operation of grantOperationSchema.options) {
      expect(row?.definition).toContain(`'${operation}'`);
    }
    expect(grantOperationSchema.options.at(-1)).toBe('rerank');
  });

  it.each([...KAANA_GRANT_OPERATIONS])('does not refuse %s', async (operation) => {
    expect(await insertViolation(operation)).toBeUndefined();
  });

  it('refuses an operation the contract does not name', async () => {
    const violation = await insertViolation('bogus');
    expect(violation?.code).toBe('23514');
    expect(violation?.constraint_name).toBe(CHECK);
  });
});
