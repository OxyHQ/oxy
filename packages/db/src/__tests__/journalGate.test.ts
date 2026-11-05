import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationJournalProblems } from '../migrate/journalGate';

describe('migrationJournalProblems', () => {
  it('flags a reused number, an older `when`, a broken snapshot chain and an orphan file after the baseline', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-journal-'));
    try {
      mkdirSync(join(folder, 'meta'));
      const entries = [
        { idx: 0, when: 300, tag: '0000_history' },
        { idx: 1, when: 100, tag: '0001_old_history' },
        { idx: 2, when: 400, tag: '0002_a' },
        { idx: 3, when: 350, tag: '0002_b' },
      ];
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }));
      for (const { tag } of entries) writeFileSync(join(folder, `${tag}.sql`), 'select 1;');
      writeFileSync(join(folder, '0003_lost.sql'), 'select 1;');
      const snapshot = (id: string, prevId: string) => JSON.stringify({ id, prevId });
      writeFileSync(join(folder, 'meta', '0001_snapshot.json'), snapshot('s1', 's0'));
      writeFileSync(join(folder, 'meta', '0002_snapshot.json'), snapshot('s2', 'elsewhere'));

      const problems = migrationJournalProblems(folder, 1);
      expect(problems.map((problem) => problem.split(':')[0])).toEqual([
        '0002_a', // prevId is not s1
        '0002_b', // number 2 at position 3
        '0002_b', // when 350 is older than 400
        '0002_b', // shares 0002_snapshot.json, which does not chain to itself
        '0003_lost.sql',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
