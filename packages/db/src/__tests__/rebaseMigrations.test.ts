import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationJournalProblems } from '../migrate/journalGate';
import { rebaseMigrations } from '../migrate/rebaseMigrations';

// Stands in for drizzle-kit: appends the next migration with a fresh snapshot.
const FAKE_GENERATE = `
const fs = require('fs'), path = require('path');
const folder = process.argv[2], name = process.argv[process.argv.indexOf('--name') + 1];
const journalPath = path.join(folder, 'meta', '_journal.json');
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const last = journal.entries[journal.entries.length - 1];
const prev = JSON.parse(fs.readFileSync(path.join(folder, 'meta', last.tag.slice(0, 4) + '_snapshot.json'), 'utf8'));
const prefix = String(journal.entries.length).padStart(4, '0');
fs.writeFileSync(path.join(folder, prefix + '_' + name + '.sql'), 'CREATE TABLE "b" ();');
fs.writeFileSync(path.join(folder, 'meta', prefix + '_snapshot.json'), JSON.stringify({ id: 'regenerated', prevId: prev.id, tables: ['a', 'b'] }));
journal.entries.push({ idx: journal.entries.length, when: Date.now(), tag: prefix + '_' + name });
fs.writeFileSync(journalPath, JSON.stringify(journal));
`;

describe('rebaseMigrations', () => {
  it("moves the branch's migration after main's and regenerates its snapshot", () => {
    const repo = mkdtempSync(join(tmpdir(), 'oxydb-rebase-'));
    const folder = join(repo, 'drizzle');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    const addMigration = (n: number, name: string, sql: string, when: number, prevId: string) => {
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const tag = `${String(n).padStart(4, '0')}_${name}`;
      journal.entries.push({ idx: n, version: '7', when, tag, breakpoints: true });
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      writeFileSync(join(folder, `${tag}.sql`), sql);
      writeFileSync(
        join(folder, 'meta', `${tag.slice(0, 4)}_snapshot.json`),
        JSON.stringify({ id: `${name}-id`, prevId }),
      );
    };
    try {
      mkdirSync(join(folder, 'meta'), { recursive: true });
      writeFileSync(join(folder, 'meta', '_journal.json'), '{"version":"7","entries":[]}');
      git('init', '-q', '-b', 'main');
      addMigration(0, 'init', 'CREATE TABLE "a" ();', 100, '00000000');
      git('add', '.');
      git('commit', '-qm', 'init');
      git('checkout', '-qb', 'feature');
      addMigration(1, 'feature_table', 'CREATE TABLE "b" ();', 200, 'init-id');
      git('add', '.');
      git('commit', '-qm', 'feature');
      git('checkout', '-q', 'main');
      addMigration(1, 'main_column', 'ALTER TABLE "a" ADD "c" text;', 300, 'init-id');
      git('add', '.');
      git('commit', '-qm', 'main');
      git('checkout', '-q', 'feature');

      const script = join(repo, '..', `${repo.split('/').pop()}-generate.js`);
      writeFileSync(script, FAKE_GENERATE);
      const result = rebaseMigrations({
        migrationsFolder: folder,
        onto: 'main',
        generateCommand: `node ${script} ${folder}`,
        log: () => {},
      });

      expect(result).toEqual({
        moved: [{ from: '0001_feature_table', to: '0002_feature_table', when: 301 }],
        generated: 'match',
      });
      expect(
        readdirSync(folder)
          .filter((file) => file.endsWith('.sql'))
          .sort(),
      ).toEqual(['0000_init.sql', '0001_main_column.sql', '0002_feature_table.sql']);
      expect(JSON.parse(readFileSync(join(folder, 'meta', '0002_snapshot.json'), 'utf8'))).toEqual({
        id: 'regenerated',
        prevId: 'main_column-id',
        tables: ['a', 'b'],
      });
      expect(migrationJournalProblems(folder, -1)).toEqual([]);
      rmSync(script);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
