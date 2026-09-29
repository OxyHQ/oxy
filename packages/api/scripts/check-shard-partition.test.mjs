import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { checkPartition, packageRelative } from './check-shard-partition.mjs';

const require = createRequire(import.meta.url);
const { assignShards, loadDurations } = require('../jest.shardSequencer.cjs');

const ROOT = '/home/runner/work/oxy/oxy/packages/api/';
const file = (path, start, end) => ({ name: `${ROOT}${path}`, perfStats: { start, end } });
const shard = (files, overrides = {}) => ({ success: true, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 0, testResults: files, ...overrides });

test('the sequencer partitions every real test file exactly once, for every shard count CI could use', () => {
  const seconds = loadDurations();
  const paths = Object.keys(seconds);
  assert.ok(paths.length > 100, 'the durations file is suspiciously small');
  // A file the durations have never seen must still be assigned.
  paths.push('src/__tests__/brandNew.test.ts');
  for (const count of [1, 2, 6, 11, 12, 13, 24]) {
    const { assignment, load } = assignShards(paths, count, seconds);
    assert.equal(assignment.size, paths.length, `${count} shards: every file assigned once`);
    for (const shardNumber of assignment.values()) assert.ok(shardNumber >= 1 && shardNumber <= count);
    if (count > 1 && count <= 24) {
      // Balance, not just correctness: LPT keeps the spread within the largest file.
      const largest = Math.max(...paths.map((p) => seconds[p] ?? 0));
      assert.ok(Math.max(...load) - Math.min(...load) <= largest, `${count} shards: spread ${Math.max(...load) - Math.min(...load)}s`);
    }
  }
});

test('the sequencer is deterministic regardless of input order', () => {
  const seconds = loadDurations();
  const paths = Object.keys(seconds);
  const a = assignShards(paths, 12, seconds).assignment;
  const b = assignShards([...paths].reverse(), 12, seconds).assignment;
  for (const path of paths) assert.equal(a.get(path), b.get(path), path);
});

test('a complete, disjoint partition passes and records durations minus each shard\'s first file', () => {
  const { problems, seconds, executed } = checkPartition({
    shardResults: [shard([file('a.test.ts', 0, 80000), file('b.test.ts', 80000, 83000)]), shard([file('c.test.ts', 0, 2000)])],
    listed: [`${ROOT}a.test.ts`, `${ROOT}b.test.ts`, `${ROOT}c.test.ts`],
    committedSeconds: { 'a.test.ts': 9, 'gone.test.ts': 4 },
  });
  assert.deepEqual(problems, []);
  assert.equal(executed, 3);
  // a kept its committed 9s (first on its shard: cold transform), b measured, c
  // first on its shard with nothing committed, gone.test.ts dropped.
  assert.deepEqual(seconds, { 'a.test.ts': 9, 'b.test.ts': 3 });
});

test('a file that ran nowhere fails', () => {
  const { problems } = checkPartition({
    shardResults: [shard([file('a.test.ts', 0, 1)])],
    listed: [`${ROOT}a.test.ts`, `${ROOT}b.test.ts`],
    committedSeconds: {},
  });
  assert.match(problems.join('\n'), /b\.test\.ts is in the suite but ran on no shard/);
});

test('a file that ran twice fails', () => {
  const { problems } = checkPartition({
    shardResults: [shard([file('a.test.ts', 0, 1)]), shard([file('a.test.ts', 0, 1)])],
    listed: [`${ROOT}a.test.ts`],
    committedSeconds: {},
  });
  assert.match(problems.join('\n'), /ran on shard 1 AND shard 2/);
});

test('a missing shard, an empty shard, a failed shard and an empty listing all fail', () => {
  assert.match(
    checkPartition({ shardResults: [null], listed: [`${ROOT}a.test.ts`], committedSeconds: {} }).problems.join('\n'),
    /shard 1: no Jest results/
  );
  assert.match(
    checkPartition({ shardResults: [shard([])], listed: [`${ROOT}a.test.ts`], committedSeconds: {} }).problems.join('\n'),
    /executed zero test files/
  );
  assert.match(
    checkPartition({ shardResults: [shard([file('a.test.ts', 0, 1)], { success: false, numFailedTestSuites: 1 })], listed: [`${ROOT}a.test.ts`], committedSeconds: {} }).problems.join('\n'),
    /Jest reported failure/
  );
  assert.match(
    checkPartition({ shardResults: [shard([file('a.test.ts', 0, 1)])], listed: [], committedSeconds: {} }).problems.join('\n'),
    /listed no files/
  );
});

test('paths outside packages/api are refused rather than mis-keyed', () => {
  assert.throws(() => packageRelative('/elsewhere/a.test.ts'), /not inside/);
});
