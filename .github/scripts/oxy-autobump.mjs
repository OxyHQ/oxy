#!/usr/bin/env node
// Pins the Oxy packages a repository consumes to their newest npm release.
//
// Run by `.github/workflows/oxy-autobump.yml` from the CALLER's checkout
// (`node oxy-autobump.mjs --packages "@oxy.so/bloom @oxy.so/core"`). Dependabot
// cannot do this for every repo: it does not read the root `catalog` of a Bun
// workspace or `overrides`, which is where the Oxy pins live.
//
// What it rewrites, in every workspace `package.json` (root included):
// `dependencies`, `devDependencies`, `optionalDependencies`, `overrides`,
// `resolutions`, and the entries of `catalog` / `catalogs.*` (top level or under
// `workspaces`). A version spec is rewritten only when it is a plain version
// with an optional `^`/`~` prefix, and the prefix is kept. `catalog:`,
// `workspace:`, `file:`, `npm:`, ranges and tags are left alone, as are
// `peerDependencies` (a peer range is a compatibility claim, not a pin) and any
// package this repository itself publishes.
//
// The edit is line-based, so a manifest's formatting is never touched. It never
// downgrades. Output: a Markdown summary on stdout, `changed=true|false` and
// `summary_file` appended to $GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
  'catalog',
]);
const SPEC = /^([\^~]?)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const LINE = /^(\s*)"([^"]+)":\s*"([^"]*)"(,?)\s*$/;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const wanted = (flag('packages') ?? '').split(/[\s,]+/).filter(Boolean);
const root = flag('root') ?? process.cwd();
const dry = args.includes('--dry-run');
if (wanted.length === 0) {
  console.error('oxy-autobump: --packages is required');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const core = (v) => v.slice(0, 3);
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

function manifests() {
  const all = git('ls-files', '-z', '--', 'package.json', '**/package.json')
    .split('\0')
    .filter(Boolean)
    .filter((f) => !/(^|\/)(node_modules|docs|__fixtures__|fixtures)\//.test(f));
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ws = rootManifest.workspaces;
  const globs = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  const res = globs
    .filter((g) => !g.startsWith('!'))
    .map(
      (g) =>
        new RegExp(
          `^${g.replace(/\/$/, '').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]+').replace(/\0/g, '.+')}/package\\.json$`,
        ),
    );
  return all.filter((f) => f === 'package.json' || res.some((r) => r.test(f)));
}

const files = manifests();
const own = new Set(
  files.map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')).name).filter(Boolean),
);

const latest = new Map();
for (const name of wanted) {
  if (own.has(name)) continue;
  const v = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(v))
    throw new Error(`${name}: registry latest is not a plain version: ${v}`);
  latest.set(name, v);
}

// The section a line belongs to: the nearest earlier line of smaller indent
// that opens an object. `catalogs.<name>` entries sit one level deeper.
function sectionOf(lines, index, indent) {
  const opens = [];
  let want = indent.length;
  for (let i = index - 1; i >= 0 && want > 0; i--) {
    const m = lines[i].match(/^(\s*)"([^"]+)":\s*\{\s*$/);
    if (m && m[1].length < want) {
      opens.push(m[2]);
      want = m[1].length;
    }
  }
  return opens;
}

const rows = [];
for (const file of files) {
  const path = join(root, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  let touched = false;
  lines.forEach((line, i) => {
    const m = line.match(LINE);
    if (!m || !latest.has(m[2])) return;
    const [, indent, name, spec, comma] = m;
    const opens = sectionOf(lines, i, indent);
    const ok = SECTIONS.has(opens[0]) || (opens[1] === 'catalogs' && opens.length === 2);
    if (!ok) return;
    const s = spec.match(SPEC);
    if (!s) return;
    const target = latest.get(name).split('.').map(Number);
    if (!newer(target, core(s.slice(2, 5).map(Number)))) return;
    const next = `${s[1]}${latest.get(name)}`;
    lines[i] = `${indent}"${name}": "${next}"${comma}`;
    rows.push({
      file,
      name,
      from: spec,
      to: next,
      section: opens[0] === 'catalogs' ? 'catalogs' : opens[0],
    });
    touched = true;
  });
  if (touched && !dry) writeFileSync(path, lines.join('\n'));
}

const byPkg = new Map();
for (const r of rows) byPkg.set(r.name, `${r.from} -> ${r.to}`);
const summary = rows.length
  ? [
      'Pins the Oxy packages this repository consumes to their newest npm release.',
      '',
      '| Package | Change | Where |',
      '| --- | --- | --- |',
      ...[...byPkg].map(
        ([n, c]) =>
          `| \`${n}\` | ${c} | ${[...new Set(rows.filter((r) => r.name === n).map((r) => `${r.file} (${r.section})`))].join(', ')} |`,
      ),
    ].join('\n')
  : '';
console.log(summary || 'oxy-autobump: already on the newest release of every watched package');
if (process.env.GITHUB_OUTPUT) {
  const summaryFile = join(process.env.RUNNER_TEMP ?? '/tmp', 'oxy-autobump-summary.md');
  writeFileSync(summaryFile, summary);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${rows.length > 0}\nsummary_file=${summaryFile}\n`,
  );
}
