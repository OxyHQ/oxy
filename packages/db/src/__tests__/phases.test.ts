/**
 * The deploy-phase marker reader and the run planner.
 *
 * Two properties carry the weight here. First, a migration that does not
 * legibly declare its side of a deploy must produce a PROBLEM rather than a
 * default — a default is exactly how the outage this module exists for
 * reached production, just relocated one layer down. Second, the planner
 * must never return an apply set that skips a migration: the ledger records
 * progress as a high-water mark (see `./ledger`), so an apply set with a hole
 * in it cannot be represented, and a planner that produced one would
 * silently record a migration as applied that never ran.
 *
 * `planMigrationRun` never throws — it returns a plan whose `blocked` field
 * the caller inspects and turns into whatever failure its own context needs
 * (a thrown error, a CI message). That is asserted directly below, because
 * the brief this test was drafted from assumed the opposite.
 */

import {
  DEPLOY_PHASES,
  MIGRATION_RUNS,
  POST_PHASE_GREP_PATTERN,
  phaseMarkerLine,
  planMigrationRun,
  readMigrationPhases,
} from '../migrate/phases';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const throwawayFolders: string[] = [];

afterAll(() => {
  for (const folder of throwawayFolders) rmSync(folder, { recursive: true, force: true });
});

/** A throwaway drizzle folder holding `<tag>.sql` for each entry given. */
function migrationFolder(files: Record<string, string>): string {
  // `oxydb-`, matching every other throwaway directory this package creates —
  // so a `oxydb-*` sweep of `tmpdir()` is complete by construction rather than
  // by nobody having introduced an outlier yet.
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-phases-'));
  throwawayFolders.push(folder);
  mkdirSync(folder, { recursive: true });
  for (const [tag, body] of Object.entries(files)) {
    writeFileSync(join(folder, `${tag}.sql`), body);
  }
  return folder;
}

describe('deploy phases', () => {
  it('has exactly two sides of a deploy', () => {
    expect(DEPLOY_PHASES).toEqual(['pre', 'post']);
  });

  it('renders a marker a migration file can carry', () => {
    expect(phaseMarkerLine('pre')).toContain('oxy:deploy-phase=pre');
  });

  it('exports the grep pattern a deploy workflow uses, matching its own marker', () => {
    expect(new RegExp(POST_PHASE_GREP_PATTERN).test(phaseMarkerLine('post'))).toBe(true);
    expect(new RegExp(POST_PHASE_GREP_PATTERN).test(phaseMarkerLine('pre'))).toBe(false);
  });
});

describe('readMigrationPhases', () => {
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
    // declaration, and honouring it would let a comment inside a DO block
    // decide when a production migration runs.
    const folder = migrationFolder({
      '0000_x': `  ${phaseMarkerLine('post')}\nINSERT INTO t VALUES ('-- oxy:deploy-phase=post');\n`,
    });
    const { problems } = readMigrationPhases(['0000_x'], folder);

    expect(problems[0]).toContain('no deploy-phase marker');
  });
});

describe('planMigrationRun', () => {
  const pending = [{ tag: 'a_pre' }, { tag: 'b_pre' }, { tag: 'c_post' }, { tag: 'd_post' }];
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

  it('refuses a pending list where a pre migration sits behind an unapplied post — by BLOCKING, not throwing', () => {
    // The ledger records progress as a high-water mark and cannot skip an
    // entry, so this pending list has no ordering that is correct for either
    // image. `planMigrationRun` reports that as a returned `blocked` string,
    // not a thrown error — asserted here because the brief's own draft of
    // this test called it with a two-argument signature and expected a
    // throw, and the real function takes three arguments and returns.
    const stranded = [
      { tag: '0009_drop_column' },
      { tag: '0010_add_column' },
    ];
    const strandedPhases = new Map<string, 'pre' | 'post'>([
      ['0009_drop_column', 'post'],
      ['0010_add_column', 'pre'],
    ]);

    const plan = planMigrationRun(stranded, strandedPhases, 'pre');

    expect(plan.blocked).not.toBeNull();
    expect(plan.blocked).toContain('0010_add_column');
    expect(plan.blocked).toContain('0009_drop_column');
    expect(plan.apply).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('BLOCKS post when a pre migration is still pending after the rollout', () => {
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
    // The ledger records "everything up to the newest applied", so a set
    // that skips a pending migration would mark that migration applied
    // without running it. Assert the apply set is a PREFIX of pending for
    // every run.
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
