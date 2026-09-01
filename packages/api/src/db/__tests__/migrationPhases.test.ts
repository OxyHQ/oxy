/**
 * The deploy-phase marker reader and the run planner.
 *
 * Two properties carry the weight here. First, a migration that does not
 * legibly declare its side of a deploy must produce a PROBLEM rather than a
 * default — a default is how `0013_users_account_categories` reached production
 * ahead of its column, just relocated one layer down. Second, the planner must
 * never return a set that skips a migration: the ledger records progress as a
 * high-water mark (`pendingEntries`), so an apply set with a hole in it cannot
 * be represented, and a planner that produced one would silently record a
 * migration as applied that never ran.
 *
 * The end-to-end behaviour — that `--phase=pre` really does leave a DROP alone
 * against a live Postgres — is exercised by the real migrator; these are the
 * pure pieces underneath it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOY_PHASES,
  MIGRATION_RUNS,
  POST_PHASE_GREP_PATTERN,
  phaseMarkerLine,
  planMigrationRun,
  readJournal,
  readMigrationPhases,
} from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';

const throwawayFolders: string[] = [];

afterAll(() => {
  for (const folder of throwawayFolders) rmSync(folder, { recursive: true, force: true });
});

/** A throwaway drizzle folder holding `<tag>.sql` for each entry given. */
function migrationFolder(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxy-phases-'));
  throwawayFolders.push(folder);
  mkdirSync(folder, { recursive: true });
  for (const [tag, body] of Object.entries(files)) {
    writeFileSync(join(folder, `${tag}.sql`), body);
  }
  return folder;
}

describe('readMigrationPhases', () => {
  it('reads every migration that actually ships with the package', () => {
    const tags = readJournal(MIGRATIONS_FOLDER).map((entry) => entry.tag);
    const { phases, problems } = readMigrationPhases(tags, MIGRATIONS_FOLDER);

    expect(problems).toEqual([]);
    expect(phases.size).toBe(tags.length);
    for (const tag of tags) {
      expect(DEPLOY_PHASES).toContain(phases.get(tag));
    }
  });

  it('accepts a marker anywhere in the file, not only the first line', () => {
    const folder = migrationFolder({
      '0000_x': `-- a header comment\n\n${phaseMarkerLine('post')}\n\nDROP TABLE "x";\n`,
    });
    const { phases, problems } = readMigrationPhases(['0000_x'], folder);

    expect(problems).toEqual([]);
    expect(phases.get('0000_x')).toBe('post');
  });

  it('tolerates CRLF, which is how a marker arrives from a Windows editor', () => {
    const folder = migrationFolder({ '0000_x': `${phaseMarkerLine('pre')}\r\nSELECT 1;\r\n` });
    const { phases, problems } = readMigrationPhases(['0000_x'], folder);

    expect(problems).toEqual([]);
    expect(phases.get('0000_x')).toBe('pre');
  });

  it('reports a missing marker and names the migration', () => {
    const folder = migrationFolder({ '0000_x': 'ALTER TABLE "users" ADD COLUMN "a" text;\n' });
    const { phases, problems } = readMigrationPhases(['0000_x'], folder);

    expect(phases.size).toBe(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0000_x: no deploy-phase marker');
  });

  it('reports two markers rather than picking one', () => {
    const folder = migrationFolder({
      '0000_x': `${phaseMarkerLine('pre')}\n${phaseMarkerLine('post')}\nSELECT 1;\n`,
    });
    const { phases, problems } = readMigrationPhases(['0000_x'], folder);

    expect(phases.size).toBe(0);
    expect(problems[0]).toContain('2 deploy-phase markers');
  });

  it('reports a misspelled phase AS a misspelling, not as an absent marker', () => {
    // Matching only `(pre|post)` would make this indistinguishable from a file
    // with no marker at all, and "you wrote no phase" sends the reader looking
    // at the wrong line.
    const folder = migrationFolder({ '0000_x': '-- oxy:deploy-phase=after\nSELECT 1;\n' });
    const { problems } = readMigrationPhases(['0000_x'], folder);

    expect(problems[0]).toContain('unrecognised deploy phase "after"');
  });

  it('reports an unreadable file rather than treating it as undeclared', () => {
    const { phases, problems } = readMigrationPhases(['0000_absent'], migrationFolder({}));

    expect(phases.size).toBe(0);
    expect(problems[0]).toContain('0000_absent: cannot read');
  });

  it('does not treat a marker-shaped string inside a statement as a marker', () => {
    // Line-anchored: an indented or mid-line occurrence is SQL, not a
    // declaration, and honouring it would let a comment inside a DO block decide
    // when a production migration runs.
    const folder = migrationFolder({
      '0000_x': `  ${phaseMarkerLine('post')}\nINSERT INTO t VALUES ('-- oxy:deploy-phase=post');\n`,
    });
    const { problems } = readMigrationPhases(['0000_x'], folder);

    expect(problems[0]).toContain('no deploy-phase marker');
  });

  it('exports the grep pattern the deploy workflow uses, matching its own marker', () => {
    // deploy-aws.yml greps with this to decide whether a release needs a
    // post-rollout task at all; if it stopped matching what `phaseMarkerLine`
    // writes, that task would be skipped and the drop applied by nothing.
    expect(new RegExp(POST_PHASE_GREP_PATTERN).test(phaseMarkerLine('post'))).toBe(true);
    expect(new RegExp(POST_PHASE_GREP_PATTERN).test(phaseMarkerLine('pre'))).toBe(false);
  });
});

describe('planMigrationRun', () => {
  const pending = [
    { tag: 'a_pre' },
    { tag: 'b_pre' },
    { tag: 'c_post' },
    { tag: 'd_post' },
  ];
  const phases = new Map<string, 'pre' | 'post'>([
    ['a_pre', 'pre'],
    ['b_pre', 'pre'],
    ['c_post', 'post'],
    ['d_post', 'post'],
  ]);

  it('applies nothing and defers nothing when nothing is pending', () => {
    for (const run of MIGRATION_RUNS) {
      expect(planMigrationRun([], phases, run)).toEqual({ apply: [], deferred: [], blocked: null });
    }
  });

  it('pre stops at the first post migration', () => {
    const plan = planMigrationRun(pending, phases, 'pre');

    expect(plan.blocked).toBeNull();
    expect(plan.apply.map((entry) => entry.tag)).toEqual(['a_pre', 'b_pre']);
    expect(plan.deferred.map((entry) => entry.tag)).toEqual(['c_post', 'd_post']);
  });

  it('pre applies everything when no post migration is pending', () => {
    const additive = pending.slice(0, 2);
    const plan = planMigrationRun(additive, phases, 'pre');

    expect(plan.apply.map((entry) => entry.tag)).toEqual(['a_pre', 'b_pre']);
    expect(plan.deferred).toEqual([]);
  });

  it('pre applies NOTHING when the first pending migration is destructive', () => {
    const plan = planMigrationRun(pending.slice(2), phases, 'pre');

    expect(plan.apply).toEqual([]);
    expect(plan.deferred.map((entry) => entry.tag)).toEqual(['c_post', 'd_post']);
    expect(plan.blocked).toBeNull();
  });

  it('post applies what pre deferred', () => {
    const plan = planMigrationRun(pending.slice(2), phases, 'post');

    expect(plan.apply.map((entry) => entry.tag)).toEqual(['c_post', 'd_post']);
    expect(plan.blocked).toBeNull();
  });

  it('all ignores phases entirely', () => {
    const plan = planMigrationRun(pending, phases, 'all');

    expect(plan.apply.map((entry) => entry.tag)).toEqual(['a_pre', 'b_pre', 'c_post', 'd_post']);
    expect(plan.deferred).toEqual([]);
  });

  it('BLOCKS pre when a pre migration is stranded behind an unapplied post one', () => {
    // The ledger cannot express a hole, so there is no ordering here that is
    // safe for both the image serving and the image arriving. Refusing names
    // both; picking either one silently breaks one of the two.
    const stranded = [{ tag: 'c_post' }, { tag: 'e_pre' }];
    const plan = planMigrationRun(
      stranded,
      new Map<string, 'pre' | 'post'>([['c_post', 'post'], ['e_pre', 'pre']]),
      'pre'
    );

    expect(plan.apply).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.blocked).toContain('e_pre');
    expect(plan.blocked).toContain('c_post');
  });

  it('BLOCKS post when a pre migration is still pending after the rollout', () => {
    // Reached only when the pre step did not run. The live image is already
    // reading a column that does not exist, so failing here is what rolls the
    // service back to the image that matches the schema.
    const plan = planMigrationRun(pending, phases, 'post');

    expect(plan.apply).toEqual([]);
    expect(plan.blocked).toContain('a_pre');
  });

  it('BLOCKS every run when a pending migration declares no phase', () => {
    for (const run of MIGRATION_RUNS) {
      const plan = planMigrationRun([{ tag: 'z_unknown' }], phases, run);

      expect(plan.apply).toEqual([]);
      expect(plan.blocked).toContain('z_unknown');
      expect(plan.blocked).toContain('do not declare a deploy phase');
    }
  });

  it('never returns an apply set with a hole in it', () => {
    // The ledger records "everything up to the newest applied", so a set that
    // skips a pending migration would mark that migration applied without
    // running it. Assert the apply set is a PREFIX of pending for every run.
    for (const run of MIGRATION_RUNS) {
      const plan = planMigrationRun(pending, phases, run);
      const applied = plan.apply.map((entry) => entry.tag);

      expect(applied).toEqual(pending.slice(0, applied.length).map((entry) => entry.tag));
    }
  });

  it('does not mutate the pending list it was handed', () => {
    const original = [...pending];
    planMigrationRun(pending, phases, 'all').apply.pop();

    expect(pending).toEqual(original);
  });
});
