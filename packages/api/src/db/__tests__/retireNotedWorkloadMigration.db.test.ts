import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { createTestDatabase, dropTestDatabase } from '../testDatabase';

const migration = readFileSync(
  join(__dirname, '../../../drizzle/0219_retire_noted_workload_binding.sql'),
  'utf8',
);
const bindingId = '01a12a46-0ab6-721d-86a0-c63669a4e9b6';
const applicationId = '6a37b3e71ddfd195b65681d2';
let databaseUrl: string;
let sql: postgres.Sql;
jest.setTimeout(60_000);

beforeAll(async () => {
  // The production tuple can appear in other fixtures. Own the entire database
  // rather than deleting an application with somebody else's usage receipts.
  databaseUrl = await createTestDatabase();
  sql = postgres(databaseUrl, { max: 1 });
  await sql`INSERT INTO users (id, color) VALUES ('retirement-owner', 'teal')`;
  await sql`INSERT INTO applications (id, name, owner_account_id, is_official)
    VALUES (${applicationId}, 'Noted', 'retirement-owner', true),
      ('retirement-nilo', 'Nilo', 'retirement-owner', true)`;
  await sql`INSERT INTO application_credentials
    (id, application_id, name, public_key, type, environment)
    VALUES ('retirement-public-client', ${applicationId}, 'Noted public',
      'oxy_dk_retirement_public', 'public', 'production')`;
  await sql`INSERT INTO application_workload_identities
    (id, application_id, provider, subject, environment)
    VALUES ('retirement-nilo-binding', 'retirement-nilo', 'aws-iam',
      'arn:aws:iam::237343248947:role/oxy-nilo-task', 'production')`;
});
afterAll(async () => {
  try {
    if (sql) await sql.end({ timeout: 5 });
  } finally {
    if (databaseUrl) await dropTestDatabase(databaseUrl);
  }
});
beforeEach(async () => {
  await sql`DELETE FROM application_workload_identities WHERE id = ${bindingId}`;
});
async function seed() {
  await sql`INSERT INTO application_workload_identities
    (id, application_id, provider, subject, environment)
    VALUES (${bindingId}, ${applicationId}, 'aws-iam',
      'arn:aws:iam::237343248947:role/oxy-noted-task', 'production')`;
}
async function preservedRows() {
  return {
    applications: await sql`SELECT * FROM applications ORDER BY id`,
    clients: await sql`SELECT * FROM application_credentials ORDER BY id`,
    nilo: await sql`SELECT * FROM application_workload_identities
      WHERE id = 'retirement-nilo-binding'`,
  };
}
it('accepts a fresh database without creating a retired binding', async () => {
  await sql.unsafe(migration);
  expect(
    await sql`SELECT id FROM application_workload_identities WHERE id = ${bindingId}`,
  ).toHaveLength(0);
});
it('expires only the exact binding, retains public-client/Nilo rows, and repeats unchanged', async () => {
  await seed();
  const before = await preservedRows();
  await sql.unsafe(migration);
  const retired = await sql`SELECT * FROM application_workload_identities WHERE id = ${bindingId}`;
  expect(retired[0].expires_at).toEqual(new Date('2026-10-25T00:00:00.000Z'));
  expect(await preservedRows()).toEqual(before);
  await sql.unsafe(migration);
  expect(await sql`SELECT * FROM application_workload_identities WHERE id = ${bindingId}`).toEqual(
    retired,
  );
});
it.each([
  ['application_id', 'retirement-nilo'],
  ['provider', 'different-provider'],
  ['subject', 'arn:aws:iam::237343248947:role/another-task'],
  ['environment', 'development'],
])('rejects %s drift without touching the row', async (column, value) => {
  await seed();
  await sql`UPDATE application_workload_identities SET ${sql(column)} = ${value}
    WHERE id = ${bindingId}`;
  const before = await sql`SELECT * FROM application_workload_identities WHERE id = ${bindingId}`;
  await expect(sql.unsafe(migration)).rejects.toThrow('identity drift');
  expect(await sql`SELECT * FROM application_workload_identities WHERE id = ${bindingId}`).toEqual(
    before,
  );
});
it('rejects an independently changed expiry without overwriting it', async () => {
  await seed();
  await sql`UPDATE application_workload_identities SET expires_at = '2026-10-24T00:00:00Z'
    WHERE id = ${bindingId}`;
  await expect(sql.unsafe(migration)).rejects.toThrow('expiry drift');
  const [row] =
    await sql`SELECT expires_at FROM application_workload_identities WHERE id = ${bindingId}`;
  expect(row.expires_at).toEqual(new Date('2026-10-24T00:00:00Z'));
});
