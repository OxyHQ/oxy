/**
 * The throwaway-database harness cleans up after a run that never reached its
 * teardown — and never after one that is still running.
 *
 * A run killed by a signal or a timeout drops nothing, and 132 migrated
 * `oxy_test_*` databases had piled up on one developer's server that way. Every
 * database now carries a label and is owned through an advisory lock its
 * process holds; the next run drops the labelled ones whose lock is free, and
 * nothing else. A pid cannot say whether the owner lives: hostnames repeat
 * across PID namespaces (host-network containers, every WSL2 distro).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import postgres from 'postgres';
import { createTestDatabase, dropTestDatabase, reapOrphanedTestDatabases } from '../testDatabase';

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

it('labels a database and holds it for as long as the process keeps it', async () => {
  const url = await createTestDatabase({ assignEnv: false });
  const name = new URL(url).pathname.slice(1);
  made.push(name);
  try {
    const [row] = await admin<{ label: string | null }[]>`
      select shobj_description(oid, 'pg_database') as label from pg_database where datname = ${name}`;
    expect(row.label).toBe(`oxy-jest owner=${hostname()}/${process.pid}`);

    // Its owner is this process, alive: the reaper leaves it.
    expect(await reapOrphanedTestDatabases()).not.toContain(name);
    expect(await exists(name)).toBe(true);
  } finally {
    await dropTestDatabase(url);
  }
  expect(await exists(name)).toBe(false);
}, 120_000);

it('reaps a database whose owner is gone, and nothing else', async () => {
  const label = `oxy-jest owner=${hostname()}/${deadPid()}`;
  const orphan = await database(label);
  // Same hostname and a pid that is dead HERE — a live run in another PID
  // namespace looks exactly like this. Its session holds the lock.
  const elsewhere = await database(label);
  const unlabelled = await database(null);

  const owner = postgres(maintenanceUrl(), { max: 1 });
  try {
    await owner`select pg_advisory_lock(hashtextextended(${`oxy-jest:${elsewhere}`}, 0))`;

    const reaped = await reapOrphanedTestDatabases();
    expect(reaped).toContain(orphan);
    expect(await exists(orphan)).toBe(false);
    for (const kept of [elsewhere, unlabelled]) {
      expect(reaped).not.toContain(kept);
      expect(await exists(kept)).toBe(true);
    }
  } finally {
    await owner.end({ timeout: 5 });
  }

  // Once its owner's session ends, it is an orphan like any other.
  expect(await reapOrphanedTestDatabases()).toContain(elsewhere);
}, 120_000);
