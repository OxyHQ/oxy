import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { mergeCoverage } from './merge-coverage.mjs';

function fileCoverage(path, statementHits = [1, 0]) {
  return {
    path,
    statementMap: {
      0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      1: { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
    },
    fnMap: {
      0: {
        name: 'coveredFunction',
        decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        line: 1,
      },
    },
    branchMap: {
      0: {
        type: 'if',
        line: 1,
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        locations: [
          { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          { start: { line: 1, column: 5 }, end: { line: 1, column: 10 } },
        ],
      },
    },
    s: { 0: statementHits[0], 1: statementHits[1] },
    f: { 0: statementHits[0] },
    b: { 0: statementHits },
  };
}

function fixture({ hits = [[1, 0], [0, 1], [0, 0]], floors = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oxy-api-coverage-'));
  const inputFiles = hits.map((shardHits, index) => {
    const directory = join(root, `shard-${index + 1}`);
    const filePath = join(directory, 'coverage-final.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ '/workspace/src/example.ts': fileCoverage('/workspace/src/example.ts', shardHits) }),
    );
    return filePath;
  });
  const floorConfigPath = join(root, 'coverage-floors.json');
  writeFileSync(
    floorConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      description: 'Test fixture',
      floors: { statements: 0, branches: 0, functions: 0, lines: 0, ...floors },
    }),
  );

  return {
    root,
    inputFiles,
    outputDir: join(root, 'merged'),
    floorConfigPath,
  };
}

function cleanup(fixtureValue) {
  rmSync(fixtureValue.root, { recursive: true, force: true });
}

test('fails when one of the three shard reports is missing', () => {
  const value = fixture();
  rmSync(value.inputFiles[2]);
  try {
    assert.throws(() => mergeCoverage(value), /Coverage shard 3 is missing/);
  } finally {
    cleanup(value);
  }
});

test('fails when a shard report is empty', () => {
  const value = fixture();
  writeFileSync(value.inputFiles[1], '');
  try {
    assert.throws(() => mergeCoverage(value), /Coverage shard 2 is empty/);
  } finally {
    cleanup(value);
  }
});

test('writes merged reports, including HTML and text, when floors pass', () => {
  const value = fixture({
    floors: { statements: 100, branches: 100, functions: 100, lines: 100 },
  });
  try {
    const result = mergeCoverage(value);
    assert.equal(result.summary.statements.pct, 100);
    for (const relativePath of [
      'coverage-final.json',
      'coverage-summary.json',
      'coverage-summary.txt',
      'lcov.info',
      'index.html',
    ]) {
      assert.ok(readFileSync(join(value.outputDir, relativePath), 'utf8').length > 0);
    }
  } finally {
    cleanup(value);
  }
});

test('fails after writing reports when merged coverage regresses below a floor', () => {
  const value = fixture({
    hits: [[1, 0], [0, 0], [0, 0]],
    floors: { statements: 51 },
  });
  try {
    assert.throws(() => mergeCoverage(value), /statements 50% < 51%/);
    assert.ok(readFileSync(join(value.outputDir, 'coverage-summary.txt'), 'utf8').length > 0);
  } finally {
    cleanup(value);
  }
});
