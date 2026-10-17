import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLockContention,
  lockRetryDelayMs,
  readMigrationStatementTimeouts,
} from '../migrate/locks';

describe('readMigrationStatementTimeouts', () => {
  it('reads a declared timeout, leaves undeclared ones to the default, and names illegible ones', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-locks-'));
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, '0000_a.sql'), '-- oxy:statement-timeout=600s\nselect 1;\n');
      writeFileSync(join(folder, '0001_b.sql'), 'select 2;\n');
      writeFileSync(join(folder, '0002_c.sql'), '-- oxy:statement-timeout=10m\nselect 3;\n');
      const result = readMigrationStatementTimeouts(['0000_a', '0001_b', '0002_c'], folder);
      expect([...result.statementTimeoutsMs]).toEqual([['0000_a', 600_000]]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/^0002_c:/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('lock retry policy', () => {
  it('retries lock timeouts and deadlocks found under a wrapper, nothing else', () => {
    const wrapped = (code: string) =>
      Object.assign(new Error('wrapper'), { cause: Object.assign(new Error('pg'), { code }) });
    expect(isLockContention(wrapped('55P03'))).toBe(true);
    expect(isLockContention(wrapped('40P01'))).toBe(true);
    expect(isLockContention(wrapped('57014'))).toBe(false);
  });

  it('jitters under an exponentially growing, capped ceiling', () => {
    expect(lockRetryDelayMs(1, 1000, 30_000, () => 0.999)).toBe(999);
    expect(lockRetryDelayMs(4, 1000, 30_000, () => 0.5)).toBe(4000);
    expect(lockRetryDelayMs(20, 1000, 30_000, () => 0.999)).toBe(29_970);
  });
});
