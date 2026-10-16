/**
 * Migrations 0168 (pre) and `*_drop_file_links` (post): `file_links` → `file_references`
 * (ADR 0043 D4), run VERBATIM against a seeded legacy table.
 *
 * Both files are read from `drizzle/` and executed statement by statement in
 * one transaction, as the migrator does. Copying their SQL here would test a
 * copy.
 *
 * ## Why its own databases
 *
 * The copy is unscoped — it reads EVERY `file_links` row — and the scenario
 * needs the schema as it stood BEFORE 0168: a `file_links` table and no
 * `file_references`. Each describe takes a fully migrated throwaway database,
 * drops `file_references`, recreates `file_links` from the statements that
 * created it (`0004_nebulous_warbound.sql`), seeds it, and only then runs the
 * migrations under test.
 *
 * ## What it pins
 *
 *  - every legacy `app` in use maps to its application: by the seed's fixed
 *    id (`goway`, `oxy-mail`), by the seed name (`mercaria`, `profiles`, a
 *    renamed `Marketplace` row ignored when suspended), or as an application
 *    id itself; a third-party application sharing an official name is never
 *    a match;
 *  - ids, creators, webhook URLs and timestamps are carried over;
 *  - the rollout-window trigger mirrors the previous image's inserts and
 *    deletes, and refuses an unmappable `app`;
 *  - an unmappable or ambiguous `app` FAILS the migration, names the value,
 *    and copies nothing;
 *  - the drop migration drops `file_links`, the trigger and both functions, and keeps every
 *    reference.
 */

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { createTestDatabase, dropTestDatabase } from '../../testDatabase';
import { LEGACY_FILE_LINK_APPLICATIONS } from '../../../utils/legacyFileLinkApplications';

jest.setTimeout(120_000);

const DRIZZLE = join(__dirname, '..', '..', '..', '..', 'drizzle');

/**
 * The post migration that drops `file_links`. Every later stage puts its own
 * `pre` migration in front of it, so its number moves; its name does not.
 */
const DROP_FILE_LINKS = (() => {
  const found = readdirSync(DRIZZLE).filter((name) => name.endsWith('_drop_file_links.sql'));
  if (found.length !== 1) throw new Error(`expected one *_drop_file_links.sql, found ${found.length}`);
  return found[0];
})();

function statements(file: string): string[] {
  return readFileSync(join(DRIZZLE, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/** The statements of 0004 that built `file_links`: its table, two FKs, two indexes. */
function legacyFileLinksDdl(): string[] {
  const ddl = statements('0004_nebulous_warbound.sql').filter((chunk) =>
    /(CREATE TABLE|ALTER TABLE|CREATE INDEX)[^;]*"file_links"/.test(chunk),
  );
  if (ddl.length !== 5) throw new Error(`expected 5 file_links statements, found ${ddl.length}`);
  return ddl;
}

async function migrate(sql: Sql, file: string): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of statements(file)) await tx.unsafe(statement);
  });
}

/** A fully migrated database put back to the shape 0168 meets: `file_links`, no `file_references`. */
async function legacyDatabase(): Promise<{ url: string; sql: Sql }> {
  const url = await createTestDatabase({ assignEnv: false });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE file_references');
  for (const statement of legacyFileLinksDdl()) await sql.unsafe(statement);
  return { url, sql };
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

async function user(sql: Sql): Promise<string> {
  const id = hex(12);
  await sql`insert into users (id, color) values (${id}, 'teal')`;
  return id;
}

async function application(
  sql: Sql,
  values: { id?: string; name: string; type?: string; status?: string },
): Promise<string> {
  const id = values.id ?? hex(12);
  await sql`
    insert into applications (id, name, type, status, owner_account_id, created_by_user_id)
    values (${id}, ${values.name}, ${values.type ?? 'first_party'}, ${values.status ?? 'active'},
            ${await user(sql)}, null)
  `;
  return id;
}

async function file(sql: Sql, ownerUserId: string): Promise<string> {
  const id = hex(12);
  const sha = hex(32);
  await sql`
    insert into files (id, sha256, size, mime, ext, owner_user_id, storage_key)
    values (${id}, ${sha}, 1, 'image/png', 'png', ${ownerUserId}, ${`content/${sha}.png`})
  `;
  return id;
}

async function link(
  sql: Sql,
  values: {
    fileId: string;
    app: string;
    createdBy: string;
    entityId?: string;
    webhookUrl?: string;
  },
): Promise<string> {
  const id = hex(12);
  await sql`
    insert into file_links (id, file_id, app, entity_type, entity_id, created_by, webhook_url)
    values (${id}, ${values.fileId}, ${values.app}, 'thing', ${values.entityId ?? hex(4)},
            ${values.createdBy}, ${values.webhookUrl ?? null})
  `;
  return id;
}

describe('the migration table and the runtime table are one table', () => {
  it('0168 resolves exactly the aliases `legacyFileLinkApplications.ts` lists', () => {
    const migration = readFileSync(join(DRIZZLE, '0168_file_references.sql'), 'utf8');
    const values = migration.slice(
      migration.indexOf('VALUES'),
      migration.indexOf('),\n  candidates'),
    );
    const rows = [...values.matchAll(/\('([^']+)', (NULL|'[^']+'), ARRAY\[([^\]]*)\]\)/g)].map(
      ([, app, id, names]) => ({
        app,
        applicationId: id === 'NULL' ? null : id.slice(1, -1),
        names: [...names.matchAll(/'([^']+)'/g)].map(([, name]) => name),
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(
      LEGACY_FILE_LINK_APPLICATIONS.map(({ app, applicationId, names }) => ({
        app,
        applicationId,
        names: [...names],
      })),
    );
  });
});

describe('0168 + the drop on links that all map', () => {
  let url: string;
  let sql: Sql;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ url, sql } = await legacyDatabase());
    ids.goway = await application(sql, { id: '73176d04c3654667138c23ec', name: 'GoWay' });
    ids.inbox = await application(sql, { id: '6a37b3e61ddfd195b656819b', name: 'Oxy Inbox' });
    ids.mercaria = await application(sql, { name: 'Mercaria' });
    // The renamed seed's old row, suspended by the seed: never a second match.
    await application(sql, { name: 'Marketplace', status: 'suspended' });
    // A third-party application that took an official name: never a match.
    await application(sql, { name: 'Mercaria', type: 'third_party' });
    ids.accounts = await application(sql, { name: 'Oxy Accounts' });
    ids.thirdParty = await application(sql, { name: 'Somebody’s app', type: 'third_party' });

    const owner = await user(sql);
    const other = await user(sql);
    const photo = await file(sql, owner);
    const attachment = await file(sql, owner);
    ids.photo = photo;
    ids.owner = owner;
    ids.gowayLink = await link(sql, {
      fileId: photo,
      app: 'goway',
      createdBy: owner,
      entityId: 'place-1',
    });
    ids.mercariaLink = await link(sql, {
      fileId: photo,
      app: 'mercaria',
      createdBy: other,
      webhookUrl: 'https://hooks.example/files',
    });
    ids.mailLink = await link(sql, { fileId: attachment, app: 'oxy-mail', createdBy: owner });
    ids.profilesLink = await link(sql, { fileId: photo, app: 'profiles', createdBy: owner });
    // An application id as `app` — the ADR 0021 consent shape.
    ids.idLink = await link(sql, { fileId: photo, app: ids.thirdParty, createdBy: owner });

    await migrate(sql, '0168_file_references.sql');
  });

  afterAll(async () => {
    await sql?.end();
    if (url) await dropTestDatabase(url);
  });

  it('copies every link, resolved to its application, with its id, creator and webhook', async () => {
    const rows = await sql<
      Array<{
        id: string;
        application_id: string;
        created_by_user_id: string;
        webhook_url: string | null;
      }>
    >`select id, application_id, created_by_user_id, webhook_url from file_references order by id`;
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(rows).toHaveLength(5);
    expect(byId.get(ids.gowayLink)?.application_id).toBe(ids.goway);
    expect(byId.get(ids.mercariaLink)).toMatchObject({
      application_id: ids.mercaria,
      webhook_url: 'https://hooks.example/files',
    });
    expect(byId.get(ids.mailLink)?.application_id).toBe(ids.inbox);
    expect(byId.get(ids.profilesLink)?.application_id).toBe(ids.accounts);
    expect(byId.get(ids.idLink)).toMatchObject({
      application_id: ids.thirdParty,
      created_by_user_id: ids.owner,
    });
  });

  it('mirrors what the previous image writes to file_links during the rollout', async () => {
    const added = await link(sql, {
      fileId: ids.photo,
      app: 'goway',
      createdBy: ids.owner,
      entityId: 'place-2',
    });
    const [mirrored] = await sql`select application_id from file_references where id = ${added}`;
    expect(mirrored?.application_id).toBe(ids.goway);

    await sql`delete from file_links where id = ${added}`;
    expect(await sql`select 1 from file_references where id = ${added}`).toHaveLength(0);

    await expect(
      link(sql, { fileId: ids.photo, app: 'not-an-app', createdBy: ids.owner }),
    ).rejects.toThrow(/not-an-app/);
  });

  it('the drop removes file_links, the trigger and both functions, and keeps every reference', async () => {
    const before = await sql`select count(*)::int as n from file_references`;

    await migrate(sql, DROP_FILE_LINKS);

    const [{ n }] = await sql`select count(*)::int as n from file_references`;
    expect(n).toBe(before[0].n);
    const [{ table }] = await sql`select to_regclass('public.file_links')::text as table`;
    expect(table).toBeNull();
    const functions = await sql`
      select proname from pg_proc
      where proname in ('oxy_file_link_application_id', 'file_links_mirror_to_file_references')
    `;
    expect(functions).toHaveLength(0);
  });
});

describe('0168 on links that do not all map', () => {
  let url: string;
  let sql: Sql;

  beforeAll(async () => {
    ({ url, sql } = await legacyDatabase());
    await application(sql, { id: '73176d04c3654667138c23ec', name: 'GoWay' });
    // Two official applications answer to `mercaria`: ambiguous, so refused.
    await application(sql, { name: 'Mercaria' });
    await application(sql, { name: 'Marketplace' });
    const owner = await user(sql);
    const photo = await file(sql, owner);
    await link(sql, { fileId: photo, app: 'goway', createdBy: owner });
    await link(sql, { fileId: photo, app: 'mystery', createdBy: owner });
    await link(sql, { fileId: photo, app: 'mercaria', createdBy: owner });
  });

  afterAll(async () => {
    await sql?.end();
    if (url) await dropTestDatabase(url);
  });

  it('fails, naming every unmappable value, and copies nothing', async () => {
    let failure: unknown;
    try {
      await migrate(sql, '0168_file_references.sql');
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toMatch(/'mercaria' \(1 links\)/);
    expect(String(failure)).toMatch(/'mystery' \(1 links\)/);
    expect(String(failure)).not.toMatch(/'goway'/);
    // The whole migration rolled back: no table, every link still there.
    const [{ table }] = await sql`select to_regclass('public.file_references')::text as table`;
    expect(table).toBeNull();
    const [{ n }] = await sql`select count(*)::int as n from file_links`;
    expect(n).toBe(3);
  });
});
