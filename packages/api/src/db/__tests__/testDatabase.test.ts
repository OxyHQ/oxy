/**
 * The throwaway-database harness cleans up after a run that never reached its
 * teardown.
 *
 * A run killed by a signal or a timeout drops nothing, and 132 migrated
 * `oxy_test_*` databases had piled up on one developer's server that way. Every
 * database now carries the host and pid of the process that will drop it, and
 * the next run drops the ones whose process is gone — and nothing else.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import postgres from 'postgres';
import { createTestDatabase, reapOrphanedTestDatabases } from '../testDatabase';

function maintenanceUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('no test Postgres server');
  const url = new URL(base);
  url.pathname = '/postgres';
  return url.toString();
}

let admin: postgres.Sql;
const made: string[] = [];

beforeAll(() => {
  admin = postgres(maintenanceUrl(), { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  for (const name of made) await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end({ timeout: 5 });
});

/** The pid of a process that has just exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

async function database(label: string | null): Promise<string> {
  const name = `oxy_test_${randomBytes(8).toString('hex')}`;
  made.push(name);
  await admin.unsafe(`create database "${name}"`);
  if (label !== null) await admin.unsafe(`comment on database "${name}" is '${label}'`);
  return name;
}

async function exists(name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${name}`;
  return rows.length === 1;
}

it('labels a database with the host and process that will drop it', async () => {
  const name = new URL(await createTestDatabase({ assignEnv: false })).pathname.slice(1);
  made.push(name);
  const [row] = await admin<{ label: string | null }[]>`
    select shobj_description(oid, 'pg_database') as label from pg_database where datname = ${name}`;
  expect(row.label).toBe(`oxy-jest owner=${hostname()}/${process.pid}`);
}, 120_000);

it('reaps what a dead process on this host left, and nothing else', async () => {
  const dead = deadPid();
  const orphan = await database(`oxy-jest owner=${hostname()}/${dead}`);
  const running = await database(`oxy-jest owner=${hostname()}/${process.pid}`);
  const otherHost = await database(`oxy-jest owner=another-host/${dead}`);
  const unlabelled = await database(null);

  const reaped = await reapOrphanedTestDatabases();
  expect(reaped).toContain(orphan);
  expect(await exists(orphan)).toBe(false);
  for (const kept of [running, otherHost, unlabelled]) {
    expect(reaped).not.toContain(kept);
    expect(await exists(kept)).toBe(true);
  }
});
