import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkSourceTopologyStructure, checkFrozenSourceTopology, FROZEN_BASE_HEAD } from './forge-source-topology.mjs';
const root = mkdtempSync(join(tmpdir(), 'forge-squash-git-fixture-'));
let count = 0;
try {
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); git('add', '--', path); };
  git('init', '--initial-branch=main'); put('README.md', 'Synthetic main fixture\n'); git('commit', '-qm', 'Synthetic baseline');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'source'); put('scripts/frozen.mjs', 'synthetic reviewed executable\n'); git('commit', '-qm', 'Synthetic frozen source');
  const source = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'decision'); put('docs/security/forge-candidate/provenance/audit-policy-decision.json', '{"synthetic":true}\n'); git('commit', '-qm', 'Synthetic declaration');
  for (const advanced of [false, true]) {
    git('checkout', '-b', advanced ? 'advanced-queue' : 'queue', base);
    if (advanced) { put('README.md', 'Unreviewed main advance\n'); git('commit', '-qm', 'Synthetic advance'); }
    git('merge', '--squash', 'decision'); git('commit', '-qm', 'Synthetic SQUASH queue');
    const head = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}'); const parents = git('show', '-s', '--format=%P').split(' ');
    assert.throws(() => git('merge-base', '--is-ancestor', source, head)); count++;
    const facts = { head, clean: true, sourceIsAncestor: false, headTree: tree, headParents: parents,
      changedPaths: git('diff', '--name-only', source, head).split('\n').filter(Boolean),
      currentGithub: { run: { repository: { id: 973881060, full_name: 'OxyHQ/oxy' }, head_repository: { full_name: 'OxyHQ/oxy' }, event: 'merge_group', head_sha: head, head_branch: `gh-readonly-queue/main/pr-1546-${base}`, pull_requests: [] }, commit: { sha: head, tree, parents } } };
    assert.equal(checkSourceTopologyStructure(facts, { sourceSha: source }, base).eligible, !advanced); count++;
    assert.equal(checkFrozenSourceTopology(facts, { sourceSha: source }).eligible, false, 'synthetic base cannot override frozen runtime base'); count++;
    if (!advanced) {
      const main = structuredClone(facts);
      main.currentGithub.queueRun = structuredClone(main.currentGithub.run);
      main.currentGithub.run.event = 'push'; main.currentGithub.run.head_branch = 'main';
      assert.equal(checkSourceTopologyStructure(main, { sourceSha: source }, base).eligible, true); count++;
      for (const mutate of [
        x => { x.currentGithub.run.head_sha = 'f'.repeat(40); },
        x => { x.currentGithub.queueRun.head_sha = 'f'.repeat(40); },
        x => { Reflect.deleteProperty(x.currentGithub, 'queueRun'); },
      ]) { const x = structuredClone(main); mutate(x); assert.equal(checkSourceTopologyStructure(x, { sourceSha: source }, base).eligible, false); count++; }
    }
    if (!advanced) for (const mutate of [
      x => { x.currentGithub.run.head_sha = 'f'.repeat(40); },
      x => { x.currentGithub.run.event = 'pull_request'; },
      x => { x.currentGithub.run.repository.full_name = 'foreign/repo'; },
      x => { x.currentGithub.commit.tree = 'f'.repeat(40); },
      x => { x.currentGithub.commit.parents.push('f'.repeat(40)); },
      x => { x.changedPaths.push('packages/api/src/server.ts'); },
      x => { x.changedPaths.push('docs/security/forge-candidate/provenance/other.json'); },
      x => { x.currentGithub.run.head_branch = `gh-readonly-queue/main/pr-1546-${'f'.repeat(40)}`; },
    ]) { const x = structuredClone(facts); mutate(x); assert.equal(checkSourceTopologyStructure(x, { sourceSha: source }, base).eligible, false); count++; }
  }
  assert.equal(checkSourceTopologyStructure(undefined, undefined, base).eligible, false); count++;
  const currentMain = 'eab1b6dd42b518500b49c03e692738081099d9cc';
  const queueHead = '1'.repeat(40);
  const frozenSource = '091cb952a3fe14adae48397e373e2e1461969dc0';
  // Structurally synthetic queue metadata bound to the authenticated current main.
  // Authentication remains the live collector's responsibility.
  const current = { head: queueHead, clean: true, sourceIsAncestor: false,
    headTree: 'd'.repeat(40), headParents: [currentMain], changedPaths: [
      'docs/security/forge-candidate/provenance/pins.json',
      'docs/security/forge-candidate/provenance/audit-policy-decision.json'],
    currentGithub: { run: { repository: { id: 973881060, full_name: 'OxyHQ/oxy' },
      head_repository: { full_name: 'OxyHQ/oxy' }, event: 'merge_group',
      head_sha: queueHead, head_branch: `gh-readonly-queue/main/pr-1573-${currentMain}` },
      commit: { sha: queueHead, tree: 'd'.repeat(40), parents: [currentMain] } } };
  assert.equal(checkFrozenSourceTopology(current, { sourceSha: frozenSource }).eligible, true, 'the reviewed actual main base must admit its exact squash topology'); count++;
  for (const wrongBase of ['82bca73efa870b013d7817aac7b7f9d63799963b', '85dad68e5685413740a4a3fd52afee5bd724bed1', '73bf4c8dbe22c30ae9c4a2f39e9b649b927b8d12', 'f'.repeat(40)]) {
    const wrong = structuredClone(current);
    wrong.headParents = [wrongBase]; wrong.currentGithub.commit.parents = [wrongBase];
    wrong.currentGithub.run.head_branch = `gh-readonly-queue/main/pr-1573-${wrongBase}`;
    assert.equal(checkFrozenSourceTopology(wrong, { sourceSha: frozenSource }).eligible, false); count++;
  }
  assert.equal(FROZEN_BASE_HEAD, currentMain); count++;

} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`${count} real Git SQUASH source-binding assertions pass; metadata is explicitly synthetic, no live approval.`);
