/**
 * The `select: false` replacement, held in place.
 *
 * `protectedColumns.ts` restores what Mongoose's `select: false` gave for free.
 * Its type-level half already fails `tsc` — `publicColumns(users).phone` does
 * not exist as a property — so what remains to check here is everything the type
 * system cannot see:
 *
 *   1. the registry still lists exactly the columns Mongoose protected,
 *   2. the runtime filter removes exactly those and nothing else,
 *   3. nobody has written a read that returns every column IMPLICITLY, which is
 *      the one way to leak a protected column without ever mentioning it.
 *
 * (3) is the reason this file scans source. `publicColumns` cannot defend
 * against not being called; a bare `db.select().from(users)` and the relational
 * `db.query.users` API both return every column, including the raw phone number
 * and the contact-discovery hashes, without naming any of them.
 */

import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { findImplicitWholeRowReads, publicColumns } from '@oxyhq/db/assert';
import { blocks } from '../blocks';
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
} from '../inferenceDeploymentRoutingScores';
import { PROTECTED_COLUMNS, PROTECTED_COLUMNS_BY_TABLE } from '../protectedColumns';
import { users } from '../users';

/**
 * The columns `models/User.ts` declares `select: false`, written out rather than
 * derived.
 *
 * Deriving them from the registry would make this assertion tautological —
 * deleting an entry would delete the expectation with it. This list is the
 * independent statement of what the Mongo schema protected, so removing a
 * column from the registry fails here and names it.
 */
const MONGOOSE_SELECT_FALSE_USER_COLUMNS = [
  'phone',
  'hashedEmail',
  'hashedPhone',
  'refreshToken',
  'emailSignature',
  'autoForwardTo',
  'autoForwardKeepCopy',
] as const;

/** `packages/api/src`. */
const SOURCE_ROOT = join(__dirname, '..', '..', '..');

/**
 * Vacuity floor for the source scan. A traversal that silently found nothing
 * would report "no leaks" for the same reason it would report anything else.
 */
const MINIMUM_SCANNED_FILES = 200;

/** Every `.ts` file under `src/`, excluding tests. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

const protectedTableNames = Object.keys(PROTECTED_COLUMNS_BY_TABLE);

describe('protected columns — the registry', () => {
  it('protects exactly the columns Mongoose marked `select: false`', () => {
    expect([...PROTECTED_COLUMNS_BY_TABLE.users]).toEqual([
      ...MONGOOSE_SELECT_FALSE_USER_COLUMNS,
    ]);
  });

  it('agrees with the reasoned list, in both directions', () => {
    const reasoned = PROTECTED_COLUMNS.filter(
      (entry) => getTableName(entry.table) === 'users'
    ).map((entry) => entry.column.name);

    // `column.name` IS the TypeScript property name here — the trap in
    // `casing.ts` is about using it as a SQL name, which this is not.
    expect(reasoned.sort()).toEqual([...MONGOOSE_SELECT_FALSE_USER_COLUMNS].sort());
  });

  it('states a reason for every protected column', () => {
    const unexplained = PROTECTED_COLUMNS.filter(
      (entry) => entry.reason.trim() === ''
    ).map((entry) => `${getTableName(entry.table)}.${entry.column.name}`);

    expect(unexplained).toEqual([]);
    expect(PROTECTED_COLUMNS.length).toBeGreaterThan(0);
  });

  it('carries no entry for a column that no longer exists', () => {
    const stale = PROTECTED_COLUMNS.filter(
      (entry) => !(entry.column.name in getTableColumns(entry.table))
    ).map((entry) => `${getTableName(entry.table)}.${entry.column.name}`);

    expect(stale).toEqual([]);
  });

  it.each([
    ['inference_deployment_routing_scores', inferenceDeploymentRoutingScores],
    ['inference_deployment_routing_score_events', inferenceDeploymentRoutingScoreEvents],
  ] as const)('protects every column of the internal table %s', (tableName, table) => {
    expect([...PROTECTED_COLUMNS_BY_TABLE[tableName]].sort()).toEqual(
      Object.keys(getTableColumns(table)).sort()
    );
  });
});

describe('protected columns — publicColumns()', () => {
  it('withholds every protected column', () => {
    const selectable = Object.keys(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE));

    expect(selectable).not.toContain('phone');
    expect(selectable).not.toContain('hashedEmail');
    expect(selectable).not.toContain('hashedPhone');
    expect(selectable).not.toContain('refreshToken');
    expect(selectable).not.toContain('emailSignature');
    expect(selectable).not.toContain('autoForwardTo');
    expect(selectable).not.toContain('autoForwardKeepCopy');
  });

  it('withholds nothing else — the removal is exactly the registry', () => {
    const all = Object.keys(getTableColumns(users));
    const selectable = new Set(Object.keys(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)));
    const missing = all.filter(
      (name) =>
        !selectable.has(name) &&
        !(MONGOOSE_SELECT_FALSE_USER_COLUMNS as readonly string[]).includes(name)
    );

    expect(missing).toEqual([]);
    // The columns a profile response is actually built from must survive.
    expect(selectable.has('id')).toBe(true);
    expect(selectable.has('username')).toBe(true);
    expect(selectable.has('email')).toBe(true);
  });

  it('returns every column of a table that protects none', () => {
    expect(Object.keys(publicColumns(blocks, PROTECTED_COLUMNS_BY_TABLE)).sort()).toEqual(
      Object.keys(getTableColumns(blocks)).sort()
    );
  });
});

describe('protected columns — no implicit whole-row read', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('scans the source tree (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);
    expect(protectedTableNames.length).toBeGreaterThan(0);
  });

  it('never calls `select()` with no columns, or uses the relational query API, against a protected table', async () => {
    // `db.select().from(users)` — the argument-less form returns EVERY column,
    // as does `db.query.users.findFirst()` unless a `columns:` projection is
    // passed. Reads as: "select the columns you need, or
    // `db.select(publicColumns(users)).from(users)`."
    const violations = await findImplicitWholeRowReads({
      sourceDir: SOURCE_ROOT,
      registry: PROTECTED_COLUMNS_BY_TABLE,
    });

    expect(violations).toEqual([]);
  });
});
