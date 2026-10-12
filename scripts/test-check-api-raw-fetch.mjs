#!/usr/bin/env bun
/**
 * Exercises check-api-raw-fetch.mjs against fixture trees.
 *
 * Every shape the gate claims to catch is planted alone and must turn it red;
 * a matched clean tree must stay green (so "everything fails" and "the gate
 * works" are different observations); every shape it claims NOT to count —
 * comments, strings, another object's `.fetch`, declarations, type positions,
 * test files — must stay green too, because a gate that fires on prose gets
 * deleted rather than obeyed. The allow-list is read out of the gate
 * (`API_RAW_FETCH_EMIT_POLICY=1`), so an entry added there is covered here.
 *
 * Fixtures live under the OS temp dir; the check runs with `cwd` set to each
 * and `API_RAW_FETCH_FIXTURE_FLOORS=1`, which LOWERS its vacuity floors (the
 * last case runs without it to prove the real floors still bite).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkScript = resolve(scriptDirectory, 'check-api-raw-fetch.mjs');
const failures = [];
const created = [];

const policy = JSON.parse(
  execFileSync('bun', [checkScript], {
    cwd: scriptDirectory,
    encoding: 'utf8',
    env: { ...process.env, API_RAW_FETCH_EMIT_POLICY: '1' },
  }),
);
if (policy.corpusRoot !== 'packages/api/src') {
  failures.push(`the gate's corpus is ${policy.corpusRoot}, not packages/api/src.`);
}
for (const required of ['globalThis', 'global', 'window', 'self']) {
  if (!policy.globalObjects.includes(required)) {
    failures.push(`the gate no longer watches \`${required}.fetch\`.`);
  }
}
const wrapper = policy.allowed.find((a) => a.file === 'packages/api/src/utils/tracedFetch.ts');
if (!wrapper) failures.push('the wrapper itself is no longer on the allow-list.');

/** A tree holding every allowed reference at its stated count, plus `extra` files. */
function fixture(extra = {}, { allowed = policy.allowed } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oxy-api-raw-fetch-'));
  created.push(root);
  const files = { 'packages/api/src/index.ts': 'export const ok = 1;\n' };
  for (const entry of allowed) {
    const line = `${entry.expression};\n`;
    files[entry.file] = (files[entry.file] ?? '') + line.repeat(entry.count);
  }
  Object.assign(files, extra);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function run(root, { floors = true } = {}) {
  const env = { ...process.env };
  if (floors) env.API_RAW_FETCH_FIXTURE_FLOORS = '1';
  else delete env.API_RAW_FETCH_FIXTURE_FLOORS;
  const result = spawnSync('bun', [checkScript], { cwd: root, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function expectStatus(name, root, expected, { floors = true, mustMention } = {}) {
  const { status, output } = run(root, { floors });
  if (status !== expected) {
    failures.push(`${name}: expected exit ${expected}, got ${status}.\n${output}`);
  } else if (mustMention && !output.includes(mustMention)) {
    failures.push(`${name}: failed, but not for the planted reason (${mustMention}).\n${output}`);
  }
}

const PLANTED = 'packages/api/src/services/planted.ts';

// ── Must pass ───────────────────────────────────────────────────────────────
expectStatus('clean tree', fixture(), 0);

const NOT_COUNTED = {
  'line comment': '// const r = await fetch(url);\n',
  'block comment': '/* fetch(url) and globalThis.fetch(url) */\nexport {};\n',
  'string literals': "export const a = 'fetch(url)';\nexport const b = `globalThis.fetch(url)`;\n",
  "another object's .fetch": 'declare const t: { fetch(u: string): void };\nt.fetch("u");\n',
  'property and method names':
    'export const o = { fetch: 1 };\nexport class A { fetch() {} }\nexport interface I { fetch: number }\n',
  'type positions':
    'export type F = typeof fetch;\nexport function f(x: typeof fetch): void { void x; }\n',
  'renamed destructure':
    'declare const obj: { fetch: number };\nconst { fetch: f } = obj;\nvoid f;\n',
};
for (const [name, text] of Object.entries(NOT_COUNTED)) {
  expectStatus(`not counted: ${name}`, fixture({ [PLANTED]: text }), 0);
}
expectStatus(
  'test files are outside the corpus',
  fixture({
    'packages/api/src/__tests__/a.test.ts': 'await fetch("x");\n',
    'packages/api/src/services/b.test.ts': 'await fetch("x");\n',
  }),
  0,
);

// ── Must fail, each shape alone ─────────────────────────────────────────────
const COUNTED = {
  call: ['export async function f() { return fetch("https://x"); }\n', '`fetch`'],
  'awaited call': ['export async function f() { await fetch("https://x"); }\n', '`fetch`'],
  'globalThis.fetch': ['globalThis.fetch("https://x");\n', '`globalThis.fetch`'],
  'global.fetch': ['global.fetch("https://x");\n', '`global.fetch`'],
  'window.fetch': ['window.fetch("https://x");\n', '`window.fetch`'],
  'self.fetch': ['self.fetch("https://x");\n', '`self.fetch`'],
  "globalThis['fetch']": ["globalThis['fetch']('https://x');\n", "`globalThis['fetch']`"],
  'stored as a value': ['export const f = fetch;\n', '`fetch`'],
  'shorthand property': ['export const deps = { fetch };\n', '`fetch`'],
  'passed as an argument': ['declare function use(f: unknown): void;\nuse(fetch);\n', '`fetch`'],
  'nullish fallback': [
    'declare const d: { f?: typeof fetch };\nexport const g = d.f ?? fetch;\n',
    '`fetch`',
  ],
  'default parameter': [
    'export class C { constructor(readonly t: typeof fetch = fetch) {} }\n',
    '`fetch`',
  ],
};
for (const [name, [text, mention]] of Object.entries(COUNTED)) {
  expectStatus(`counted: ${name}`, fixture({ [PLANTED]: text }), 1, { mustMention: mention });
}

// A .tsx file is in the corpus too.
expectStatus(
  'counted in .tsx',
  fixture({
    'packages/api/src/views/page.tsx': 'export const P = () => <a onClick={() => fetch("x")} />;\n',
  }),
  1,
  { mustMention: 'page.tsx' },
);

// ── The allow-list is exact in both directions ─────────────────────────────
if (wrapper) {
  expectStatus(
    'an allowed file with one reference too many',
    fixture({ [wrapper.file]: `${wrapper.expression};\n`.repeat(wrapper.count + 1) }),
    1,
    { mustMention: 'ALLOWED says' },
  );
  expectStatus(
    'an allowed reference that is gone',
    fixture({}, { allowed: policy.allowed.filter((a) => a !== wrapper) }),
    1,
    { mustMention: 'ALLOWED says' },
  );
}

// ── Cannot pass vacuously ──────────────────────────────────────────────────
expectStatus('a file that does not parse', fixture({ [PLANTED]: 'export const = ;\n' }), 1, {
  mustMention: 'did not parse',
});
expectStatus('a tiny tree under the REAL floors', fixture(), 1, {
  floors: false,
  mustMention: 'floor',
});

for (const root of created) rmSync(root, { recursive: true, force: true });

const cases =
  1 + Object.keys(NOT_COUNTED).length + 1 + Object.keys(COUNTED).length + 1 + (wrapper ? 2 : 0) + 2;
if (failures.length > 0) {
  console.error(`check-api-raw-fetch fixture tests FAILED (${failures.length} of ${cases}):\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}
console.log(`check-api-raw-fetch.mjs behaves: ${cases} fixture cases.`);
