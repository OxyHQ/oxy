#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = join(repoRoot, 'scripts', 'check-kaana-dns-boundary.mjs');
const workflow = join('.github', 'workflows', 'cloudflare-dns-kaana.yml');
const fixtures = [];
const failures = [];

function fixture(rewrite = (value) => value) {
  const root = mkdtempSync(join(tmpdir(), 'oxy-kaana-dns-'));
  fixtures.push(root);
  const target = join(root, workflow);
  mkdirSync(dirname(target), { recursive: true });
  const source = readFileSync(join(repoRoot, workflow), 'utf8');
  const changed = rewrite(source);
  writeFileSync(target, changed);
  return root;
}

function verdict(name, root, expectedCode, expectedText) {
  let code = 0;
  let output = '';
  try {
    output = execFileSync('node', [check], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (code !== expectedCode || !output.includes(expectedText)) {
    failures.push(`${name}: expected exit ${expectedCode} containing ${JSON.stringify(expectedText)}; got ${code}\n${output}`);
  }
}

verdict('real workflow', fixture(), 0, 'Kaana DNS boundary is exact');
verdict(
  'unproxied apex',
  fixture((value) => value.replace('KAANA_ALB_DNS"].rstrip("."), True', 'KAANA_ALB_DNS"].rstrip("."), False')),
  1,
  'apex must stay Cloudflare-proxied',
);
verdict(
  'proxied validation',
  fixture((value) => value.replace('VAL_VALUE"].rstrip("."), False', 'VAL_VALUE"].rstrip("."), True')),
  1,
  'validation CNAME must stay DNS-only',
);

for (const root of fixtures) rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Kaana DNS boundary check discriminated ${fixtures.length} fixture cases.`);
