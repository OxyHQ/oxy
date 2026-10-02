import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { policyTestRepository, SYNTHETIC_INACTIVE } from './forge-policy-test-fixtures.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  checkForgePolicyStructure, inspectForgeAuditPolicy, DECISION_PATH, DECLARATIVE_PATHS, EVIDENCE_PATH, INDEPENDENT_INPUT_PATHS, readCommittedPolicyStatus,
} from './forge-audit-policy.mjs';
import { TRUSTED_BASELINE, TRUSTED_WORKFLOW, sha256 } from './forge-remediation-proof-proposal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const proofBytes = readFileSync(join(root, EVIDENCE_PATH));
const proof = JSON.parse(proofBytes);
const records = Object.fromEntries(proof.records.map(row => [row.file, readFileSync(join(root, dirname(EVIDENCE_PATH), row.file))]));
const audit = JSON.parse(readFileSync(join(root, 'docs/security/forge-candidate/provenance/run-36951283961/raw-bun-audit.json')));
const source = 'a'.repeat(40), head = 'b'.repeat(40);
const paths = ['.github/workflows/ci.yml', 'scripts/check-dependency-audit.mjs', 'scripts/forge-audit-policy.mjs', 'scripts/test-forge-audit-policy.mjs', 'scripts/test-check-dependency-audit.mjs', 'scripts/forge-policy-test-fixtures.mjs', 'scripts/forge-source-topology.mjs', 'scripts/test-forge-source-topology.mjs', 'scripts/forge-final-image-binding.mjs', 'scripts/test-forge-final-image-binding.mjs', ...TRUSTED_WORKFLOW.executedPaths];
let assertions = 0;
// Every ACTIVE value below is SYNTHETIC. It does not name or claim a real Nate decision.
function fixture() {
  return {
    decision: { schemaVersion: 1, status: 'ACTIVE', targetSourceHead: source, expiresAt: '2026-10-03T12:00:00.000Z',
      authorizationRecord: { channel: 'explicit-user-session', reference: 'SYNTHETIC fixture decision only', instructionSha256: 'c'.repeat(64), recordedAt: '2026-10-02T12:00:00.000Z' },
      independentEvidence: { sourceHead: proof.candidateCommit, proofSha256: sha256(proofBytes) } },
    audit: structuredClone(audit),
    facts: { pins: { sourceSha: source }, git: { head, clean: true, sourceIsAncestor: true, changedPaths: [...DECLARATIVE_PATHS] } },
    proposal: { authenticatedProvenance: true, machineChecksPassed: true, approved: false, proposalOnly: true, errors: [] },
    proofBytes, recordBytes: { ...records }, copies: [{ version: '1.4.0', files: { ...TRUSTED_BASELINE.files } }],
    blobs: { source: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])), current: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) },
    independentInputs: { reviewed: Object.fromEntries(INDEPENDENT_INPUT_PATHS.map(path => [path, '1'.repeat(40)])), target: Object.fromEntries(INDEPENDENT_INPUT_PATHS.map(path => [path, '1'.repeat(40)])) },
    now: '2026-10-02T12:30:00.000Z',
  };
}
const positive = checkForgePolicyStructure(fixture());
assert.equal(positive.structurallyEligible, true, positive.errors.join('\n')); assertions++;
assert.equal(positive.authorized, false); assertions++;
const cases = [
  ['inactive', x => { x.decision.status = 'INACTIVE'; }],
  ['missing decision', x => { x.decision = null; }],
  ['unexpected root field', x => { x.decision.approved = true; }],
  ['unexpected authorization field', x => { x.decision.authorizationRecord.actor = 'shared-account-is-not-human-proof'; }],
  ['unexpected evidence field', x => { x.decision.independentEvidence.approval = true; }],
  ['no explicit instruction record', x => { x.decision.authorizationRecord = null; }],
  ['GitHub actor cannot substitute for session instruction', x => { x.decision.authorizationRecord.channel = 'github-actor'; }],
  ['expiry boundary', x => { x.decision.expiresAt = x.now; }],
  ['overlong duration', x => { x.decision.expiresAt = '2026-10-10T12:00:00.000Z'; }],
  ['future recorded decision', x => { x.decision.authorizationRecord.recordedAt = '2026-10-02T13:00:00.000Z'; }],
  ['invalid date', x => { x.decision.expiresAt = 'never'; }],
  ['wrong target', x => { x.decision.targetSourceHead = 'e'.repeat(40); }],
  ['new advisory anywhere', x => { x.audit.other = [{ severity: 'high', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }]; }],
  ['empty audit', x => { x.audit = {}; }],
  ['unreadable audit', x => { x.audit = null; }],
  ['second Forge advisory', x => { x.audit['node-forge'].push({ ...x.audit['node-forge'][0] }); }],
  ['Forge critical', x => { x.audit['node-forge'][0].severity = 'critical'; }],
  ['other version range', x => { x.audit['node-forge'][0].vulnerable_versions = '<=1.5.0'; }],
  ['collector not authenticated', x => { x.proposal.authenticatedProvenance = false; }],
  ['machine checks failed', x => { x.proposal.machineChecksPassed = false; }],
  ['approval flag override', x => { x.proposal.approved = true; }],
  ['prototype error', x => { x.proposal.errors = ['mismatch']; }],
  ['descendant queue requires own image', x => { x.facts.git.currentGithub = { run: { event: 'merge_group' } }; }],
  ['main push requires own image', x => { x.facts.git.currentGithub = { run: { event: 'push' } }; }],
  ['main dispatch requires own image', x => { x.facts.git.currentGithub = { run: { event: 'workflow_dispatch' } }; }],
  ['dirty checkout', x => { x.facts.git.clean = false; }],
  ['foreign ancestor', x => { x.facts.git.sourceIsAncestor = false; }],
  ['modified app code', x => { x.facts.git.changedPaths.push('packages/api/src/server.ts'); }],
  ['executable under provenance', x => { x.facts.git.changedPaths.push('docs/security/forge-candidate/provenance/arbitrary.mjs'); }],
  ['extra JSON under provenance', x => { x.facts.git.changedPaths.push('docs/security/forge-candidate/provenance/other.json'); }],
  ['changed audit code', x => { x.blobs.current['scripts/check-dependency-audit.mjs'] = 'f'.repeat(40); }],
  ['changed evaluator code', x => { x.blobs.current['scripts/forge-audit-policy.mjs'] = 'f'.repeat(40); }],
  ['changed workflow', x => { x.blobs.current[TRUSTED_WORKFLOW.path] = 'f'.repeat(40); }],
  ['absent installed inventory', x => { x.copies = []; }],
  ['stock installed copy', x => { x.copies[0].files['lib/rsa.js'] = '0'.repeat(64); }],
  ['hidden second stock copy', x => { x.copies.push({ version: '1.4.0', files: {} }); }],
  ['version renamed', x => { x.copies[0].version = '1.4.0-patched'; }],
  ['evidence digest mismatch', x => { x.decision.independentEvidence.proofSha256 = '0'.repeat(64); }],
  ['evidence source mismatch', x => { x.decision.independentEvidence.sourceHead = 'f'.repeat(40); }],
  ['changed source packages since independent suites', x => { x.independentInputs.target.packages = '2'.repeat(40); }],
  ['missing independent input', x => { delete x.independentInputs.reviewed['bun.lock']; }],
  ['raw log modified', x => { x.recordBytes['candidate-upstream.log'] = Buffer.from('fake pass'); }],
  ['raw log absent', x => { delete x.recordBytes['expo-14-final.log']; }],
];
for (const [name, mutate] of cases) {
  const x = fixture(); mutate(x);
  const result = checkForgePolicyStructure(x);
  assert.equal(result.structurallyEligible, false, name); assertions++;
  assert.equal(result.authorized, false, name); assertions++;
}
// Real Git mechanics only: fixture executable bytes/proposal stay SYNTHETIC.
const mergeRoot = mkdtempSync(join(tmpdir(), 'forge-policy-merge-fixture-'));
try {
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', mergeRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, bytes) => { mkdirSync(dirname(join(mergeRoot, path)), { recursive: true }); writeFileSync(join(mergeRoot, path), bytes); };
  git('init', '--initial-branch=main');
  for (const path of [...paths, ...DECLARATIVE_PATHS]) put(path, 'synthetic baseline fixture\n');
  git('add', '--', ...paths, ...DECLARATIVE_PATHS); git('commit', '-m', 'Synthetic baseline fixture');
  const baseline = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'frozen-source'); put('scripts/forge-audit-policy.mjs', 'synthetic frozen executable fixture\n');
  git('add', '--', 'scripts/forge-audit-policy.mjs'); git('commit', '-m', 'Synthetic frozen target fixture');
  const target = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'declarative-decision');
  for (const path of DECLARATIVE_PATHS) put(path, 'synthetic later declarative fixture\n');
  git('add', '--', ...DECLARATIVE_PATHS); git('commit', '-m', 'Synthetic declaration fixture');
  for (const advanced of [false, true]) {
    git('checkout', '-b', advanced ? 'advanced-main' : 'unchanged-main', baseline);
    if (advanced) { put('README.md', 'unreviewed main change fixture\n'); git('add', '--', 'README.md'); git('commit', '-m', 'Synthetic unrelated main change'); }
    git('merge', '--no-ff', 'declarative-decision', '-m', 'Synthetic PR merge fixture');
    git('merge-base', '--is-ancestor', target, 'HEAD');
    const x = fixture(); x.decision.targetSourceHead = target; x.facts.pins.sourceSha = target;
    x.facts.git = { head: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain') === '', sourceIsAncestor: true,
      changedPaths: git('diff', '--name-only', target, 'HEAD').split('\n').filter(Boolean) };
    x.blobs = { source: Object.fromEntries(paths.map(path => [path, git('rev-parse', `${target}:${path}`)])),
      current: Object.fromEntries(paths.map(path => [path, git('rev-parse', `HEAD:${path}`)])) };
    const result = checkForgePolicyStructure(x);
    assert.equal(result.structurallyEligible, !advanced, 'synthetic merge must reject extra main content'); assertions++;
    assert.equal(result.authorized, false, 'real Git mechanics still do not authenticate a human'); assertions++;
  }
} finally { rmSync(mergeRoot, { recursive: true, force: true }); }

// These real-code gate checks run against separately committed synthetic policies.
// They remain valid when the reviewed repository later changes state.
for (const [name, decision, expectedStatus, invalid] of [
  ['inactive', SYNTHETIC_INACTIVE, 'INACTIVE', false],
  ['synthetic active with injected audit', fixture().decision, 'ACTIVE', false],
  ['synthetic expired with injected audit', { ...fixture().decision, expiresAt: '2026-10-01T12:00:00.000Z' }, 'ACTIVE', false],
  ['synthetic missing evidence with injected audit', { ...fixture().decision, independentEvidence: null }, 'ACTIVE', false],
  ['malformed', { ...SYNTHETIC_INACTIVE, unexpected: true }, null, true],
]) {
  const repository = policyTestRepository(decision);
  try {
    const module = await import(pathToFileURL(join(repository.root, 'scripts/forge-audit-policy.mjs')).href);
    if (invalid) { assert.throws(() => module.readCommittedPolicyStatus(), /Invalid/); assertions++; }
    else { assert.equal(module.readCommittedPolicyStatus(), expectedStatus); assertions++; }
    const env = { ...process.env, DEPENDENCY_AUDIT_INPUT: join(root, 'docs/security/forge-candidate/provenance/run-36951283961/raw-bun-audit.json'),
      FORGE_ACK: '1', FORGE_APPROVED: '1', FORGE_AUDIT_POLICY_ACTIVE: '1', DEPENDENCY_AUDIT_SKIP_FORGE: '1' };
    const gate = spawnSync('bun', [join(repository.root, 'scripts/check-dependency-audit.mjs')], { cwd: repository.root, encoding: 'utf8', env });
    assert.equal(gate.status, 1, name + ': fixtures cannot authorize the real gate'); assertions++;
    assert.match(gate.stderr, /node-forge carries a high advisory nobody has acknowledged: GHSA-86w9-cpqp-85rv/); assertions++;
    if (expectedStatus === 'ACTIVE') { assert.match(gate.stderr, /Injected audit payload cannot authorize remediation/); assertions++; }
    if (invalid) { assert.match(gate.stderr, /Invalid closed policy JSON/); assertions++; }
  } finally { repository.remove(); }
}
// The legacy audit fixture group must also pass when its checkout contains ACTIVE.
// Its own offline fixture repository always has a synthetic INACTIVE policy.
const activeCheckout = policyTestRepository(fixture().decision);
try {
  for (const path of ['scripts/test-check-dependency-audit.mjs', 'scripts/forge-policy-test-fixtures.mjs']) {
    writeFileSync(join(activeCheckout.root, path), readFileSync(join(root, path)));
  }
  const group = spawnSync('bun', [join(activeCheckout.root, 'scripts/test-check-dependency-audit.mjs')], { cwd: activeCheckout.root, encoding: 'utf8' });
  assert.equal(group.status, 0, group.stderr); assertions++;
  assert.match(group.stdout, /All 9 dependency-audit cases passed/); assertions++;
} finally { activeCheckout.remove(); }
for (const path of ['scripts/test-forge-source-topology.mjs', 'scripts/test-forge-final-image-binding.mjs']) {
  const result = spawnSync('bun', [join(root, path)], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assertions++;
  process.stdout.write(result.stdout);
}
console.log(`Forge audit policy: ${assertions} structural and isolated policy assertions passed; no live or human authorization claimed.`);
