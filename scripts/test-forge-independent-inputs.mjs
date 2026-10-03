import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPinnedIndependentInputObjects, INDEPENDENT_INPUT_PATHS } from './forge-remediation-proof-proposal.mjs';

// Real squash/clone/object mechanics, synthetic GitHub JSON. No live authority.
const root = mkdtempSync(join(tmpdir(), 'forge-historical-input-fixture-'));
const original = join(root, 'original'), clean = join(root, 'clean');
let assertions = 0;
const git = (repository, ...args) => execFileSync('/usr/bin/git', ['-C', repository,
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(original);
  git(original, 'init', '--initial-branch=main');
  writeFileSync(join(original, 'README.md'), 'Synthetic baseline\n');
  git(original, 'add', '--', 'README.md'); git(original, 'commit', '-m', 'Baseline');
  git(original, 'checkout', '-b', 'historical-reviewed');
  const files = INDEPENDENT_INPUT_PATHS.map(path => path === 'packages' ? 'packages/api/package.json' : path);
  for (const path of files) {
    mkdirSync(dirname(join(original, path)), { recursive: true });
    writeFileSync(join(original, path), `Synthetic input ${path}\n`);
  }
  git(original, 'add', '--', ...files); git(original, 'commit', '-m', 'Historical reviewed inputs');
  const historical = git(original, 'rev-parse', 'HEAD');
  git(original, 'checkout', 'main'); git(original, 'merge', '--squash', 'historical-reviewed');
  git(original, 'commit', '-m', 'Squash reviewed inputs'); git(original, 'branch', '-D', 'historical-reviewed');
  execFileSync('/usr/bin/git', ['clone', '--no-local', '--single-branch', '--branch', 'main', original, clean], { stdio: ['ignore', 'pipe', 'pipe'] });
  const absentCommit = spawnSync('/usr/bin/git', ['-C', clean, 'cat-file', '-e', `${historical}^{commit}`]);
  assert.equal(absentCommit.status, 128); assertions++;
  const absentInput = spawnSync('/usr/bin/git', ['-C', clean, 'rev-parse', `${historical}:packages`]);
  assert.equal(absentInput.status, 128); assertions++;
  console.log(`Reproduced legacy local Git failure: historical commit exit=${absentCommit.status}, historical packages exit=${absentInput.status}; both absent after squash clone.`);

  const prefix = 'repos/OxyHQ/oxy/git/', responses = new Map();
  const url = path => `https://api.github.com/${path}`;
  const top = git(original, 'rev-parse', `${historical}^{tree}`);
  const commitPath = `${prefix}commits/${historical}`;
  responses.set(commitPath, { sha: historical, url: url(commitPath), tree: { sha: top, url: url(`${prefix}trees/${top}`) } });
  const visit = sha => {
    const path = `${prefix}trees/${sha}`;
    if (responses.has(path)) return;
    const tree = git(original, 'ls-tree', sha).split('\n').filter(Boolean).map(line => {
      const [, mode, type, sha, name] = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
      return { path: name, mode, type, sha };
    });
    responses.set(path, { sha, url: url(path), truncated: false, tree });
    for (const entry of tree) if (entry.type === 'tree') visit(entry.sha);
  };
  visit(top);
  const get = map => path => {
    assert.match(path, /^repos\/OxyHQ\/oxy\/git\/(commits|trees)\/[a-f0-9]{40}$/);
    if (!map.has(path)) throw new Error('Synthetic endpoint missing');
    return structuredClone(map.get(path));
  };
  const recovered = readPinnedIndependentInputObjects(historical, get(responses));
  assert.equal(Object.keys(recovered).length, 10); assertions++;
  for (const path of INDEPENDENT_INPUT_PATHS) {
    assert.equal(recovered[path], git(original, 'rev-parse', `${historical}:${path}`)); assertions++;
    assert.equal(recovered[path], git(clean, 'rev-parse', `HEAD:${path}`)); assertions++;
  }
  const rootPath = `${prefix}trees/${top}`;
  const entry = (map, name) => map.get(rootPath).tree.find(row => row.path === name);
  const cases = [
    ['foreign commit', map => { map.get(commitPath).sha = '0'.repeat(40); }],
    ['foreign commit repository', map => { map.get(commitPath).url = url(commitPath.replace('OxyHQ/oxy', 'foreign/oxy')); }],
    ['foreign commit tree URL', map => { map.get(commitPath).tree.url = 'https://evil.invalid/tree'; }],
    ['invalid commit tree SHA', map => { map.get(commitPath).tree.sha = 'invalid'; }],
    ['wrong tree SHA', map => { map.get(rootPath).sha = '0'.repeat(40); }],
    ['foreign tree URL', map => { map.get(rootPath).url = 'https://evil.invalid/tree'; }],
    ['truncated', map => { map.get(rootPath).truncated = true; }],
    ['missing truncation status', map => { delete map.get(rootPath).truncated; }],
    ['ambiguous entries', map => { map.get(rootPath).tree.push(structuredClone(entry(map, 'bun.lock'))); }],
    ['missing file', map => { map.get(rootPath).tree = map.get(rootPath).tree.filter(row => row.path !== 'bun.lock'); }],
    ['symlink', map => { entry(map, 'bun.lock').mode = '120000'; }],
    ['submodule', map => { entry(map, 'packages').type = 'commit'; entry(map, 'packages').mode = '160000'; }],
    ['packages blob', map => { entry(map, 'packages').type = 'blob'; entry(map, 'packages').mode = '100644'; }],
    ['file tree', map => { entry(map, 'bun.lock').type = 'tree'; entry(map, 'bun.lock').mode = '040000'; }],
    ['invalid input SHA', map => { entry(map, 'bun.lock').sha = 'not-a-sha'; }],
    ['missing nested tree', map => { map.delete(`${prefix}trees/${entry(map, 'scripts').sha}`); }],
    ['overlarge tree', map => { map.get(rootPath).tree = Array.from({ length: 2501 }, (_, index) => ({ path: `x${index}` })); }],
  ];
  for (const [name, mutate] of cases) {
    const map = structuredClone(responses); mutate(map);
    assert.throws(() => readPinnedIndependentInputObjects(historical, get(map)), undefined, name); assertions++;
  }
  assert.throws(() => readPinnedIndependentInputObjects('HEAD', get(responses)), /Exact historical commit/); assertions++;
  assert.throws(() => readPinnedIndependentInputObjects('0'.repeat(40), get(responses)), /endpoint missing/); assertions++;
  assert.throws(() => readPinnedIndependentInputObjects(historical, () => { throw new Error('API unavailable'); }), /API unavailable/); assertions++;
  console.log(`Historical independent inputs: ${assertions} assertions passed; clean squash clone lacks historical commit; synthetic GitHub responses do not authorize policy.`);
} finally { rmSync(root, { recursive: true, force: true }); }
