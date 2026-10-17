#!/usr/bin/env bun
/**
 * Exercises check-retired-native-agent-lane.mjs against throwaway git trees:
 * a retired term in source fails, the same term in a history record passes, and
 * a clean tree passes — so "everything fails" and "the gate works" are not the
 * same observation.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'check-retired-native-agent-lane.mjs',
);

function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'retired-lane-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    return spawnSync('bun', [CHECK], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  ['a clean tree passes', { 'src/a.ts': 'export const a = 1;\n' }, 0],
  ['a retired route in source fails', { 'src/r.ts': "router.post('/native-agents/x')\n" }, 1],
  ['a retired header in a comment fails', { 'src/h.ts': '// X-Oxy-Requester-Assertion\n' }, 1],
  [
    'a retired identifier in a workflow fails',
    { '.github/workflows/w.yml': 'NATIVE_PRODUCT_AGENTS\n' },
    1,
  ],
  ['the superseded ADR passes', { 'docs/adr/0025-old.md': 'RequesterAssertion\n' }, 0],
  ['a changelog passes', { 'packages/core/CHANGELOG.md': 'mintRequesterAssertion\n' }, 0],
];

let failed = 0;
for (const [name, files, expected] of cases) {
  const result = run(files);
  if (result.status !== expected) {
    failed += 1;
    console.error(`FAIL ${name}: exit ${result.status}, expected ${expected}\n${result.stderr}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
if (failed > 0) process.exit(1);
