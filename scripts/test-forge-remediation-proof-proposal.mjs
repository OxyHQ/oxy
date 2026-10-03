import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ADVISORY, FILES, SUITES, ARM_PRUNED_LINKS, ARM_PRUNING_RECEIPT, TRUSTED_BASELINE, TRUSTED_WORKFLOW, PROVENANCE_DIR, sha256, canonicalAudit, inventory, inventoryHash, evaluate, readZip, expectedRegressionRows, collect } from './forge-remediation-proof-proposal.mjs';
import { scanRoots } from './forge-candidate-image-roots.mjs';
let checks = 0;
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const recorded = join(repo, PROVENANCE_DIR, 'run-36951283961');
const SOURCE = 'da4121cea3040f42d471456a703a1c32da0dba37';
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
const blob = path => { try { return git('rev-parse', `${SOURCE}:${path}`).toString().trim(); } catch { return null; } };
// Real facts for the recorded run: git objects of the evidence source plus the recorded authenticated API reads.
const REAL = Object.freeze({
  audit: readFileSync(join(repo, 'docs/security/forge-candidate/current-raw-bun-audit.json')), api: readFileSync(join(recorded, 'github-api.json')), zip: readFileSync(join(recorded, 'artifact.zip')),
  pins: readFileSync(join(recorded, 'pins.json')), // the historic run owns its pins; live pins.json may move on
  git: { head: SOURCE, clean: true, sourceIsAncestor: true, changedPaths: [], blobsAtSource: Object.fromEntries(TRUSTED_WORKFLOW.executedPaths.map(path => [path, blob(path)])),
    sourceCommitTime: git('show', '-s', '--format=%cI', SOURCE).toString().trim(), patchBytes: git('show', `${SOURCE}:patches/node-forge@1.4.0.patch`),
    lockText: git('show', `${SOURCE}:bun.lock`).toString(), candidateHashes: git('show', `${SOURCE}:docs/security/forge-candidate/candidate-hashes.json`).toString() },
});
function real() {
  const github = JSON.parse(REAL.api);
  return { audit: JSON.parse(REAL.audit), pins: JSON.parse(REAL.pins), git: { ...REAL.git, blobsAtSource: { ...REAL.git.blobsAtSource } }, github, artifactZip: REAL.zip, now: github.recordedAt };
}
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
// Re-pack the artifact and re-pin it coherently: the caller-controlled pins follow every byte change.
// With api:true the recorded GitHub digest follows too, isolating the semantic checks behind it.
function repack(x, change, { api = false } = {}) {
  const entries = readZip(x.artifactZip);
  const json = name => JSON.parse(entries.get(name));
  const put = (name, value) => entries.set(name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  change({ entries, json, put });
  x.artifactZip = zip(entries);
  x.pins.artifactFiles = Object.fromEntries([...entries].map(([name, data]) => [name, sha256(data)]));
  x.pins.artifactDigest = `sha256:${sha256(x.artifactZip)}`;
  if (api) { x.github.artifact.digest = x.pins.artifactDigest; x.github.artifact.size_in_bytes = x.artifactZip.length; }
  return x;
}
function rootsFor(proof, extra = []) {
  return { diagnosticOnly: true, approval: false, root: '/', excluded: ['/dev', '/proc', '/proof/scripts', '/sys'], installRoots: ['/app', '/app/packages/api', '/usr/local/lib'],
    forgeCopies: [...proof.copies.map(({ realpath, version, files }) => ({ path: realpath, version, files })), ...extra] };
}
const CONFIG_ID = 'sha256:a0b41f5fb84990cd0c3d341a44d81cd86414ed7c0b3284f61b1c3612a9a23532';
const mountTargets = (change = () => {}) => { const m = { diagnosticOnly: true, approval: false, mounts: 'none', sourceSha: SOURCE, imageId: CONFIG_ID,
  targets: ['/proof/scripts', '/proof/hashes', '/proof/patches'].map(path => ({ path, present: false })) }; change(m); return m; };
// SYNTHETIC future-run control: the real artifact plus a whole-image root scan, as the hardened workflow emits.
function complete() {
  const x = real();
  repack(x, ({ json, put }) => { put('forge-image-roots.json', rootsFor(json('forge-image-regression-proof.json'))); put('forge-image-mount-targets.json', mountTargets()); }, { api: true });
  x.github.job.steps = TRUSTED_WORKFLOW.steps.map(name => ({ name, conclusion: 'success' }));
  x.github.blobsAtMerge['scripts/forge-source-topology.mjs'] = x.git.blobsAtSource['scripts/forge-source-topology.mjs'] = 'e'.repeat(40);
  x.github.blobsAtMerge['scripts/forge-candidate-image-roots.mjs'] = x.git.blobsAtSource['scripts/forge-candidate-image-roots.mjs'] = 'f'.repeat(40);
  return x;
}
const proofOf = x => JSON.parse(readZip(x.artifactZip).get('forge-image-regression-proof.json'));
function callerPair(x) {
  const claim = { status: 'CANDIDATE_UNAPPROVED', advisory: ADVISORY, package: 'node-forge', version: '1.4.0', sourceHead: x.pins.sourceSha, rawAuditSha256: sha256(canonicalAudit(x.audit)),
    patchSha256: TRUSTED_BASELINE.patchSha256, files: { ...TRUSTED_BASELINE.files }, intentionalDanglingSharpLinks: structuredClone(ARM_PRUNED_LINKS), pruningReceipt: { ...ARM_PRUNING_RECEIPT } };
  const proof = proofOf(x);
  const evidence = { sourceHead: x.pins.sourceSha, rawAuditSha256: claim.rawAuditSha256, patchSha256: claim.patchSha256, inventorySha256: proof.inventorySha256, pruningReceipt: { ...ARM_PRUNING_RECEIPT },
    suites: Object.fromEntries(SUITES.map(name => [name, 'pass'])), counts: { rsaControls: 321 }, actualImage: { ...x.pins.image, platform: 'linux/arm64', run: x.pins.runId }, limits: { policyApproved: false } };
  return { claim, evidence };
}
// Seal a caller pair coherently: every caller hash is recomputed after the change.
function seal(x, { claim, evidence }) { x.testEvidenceBytes = Buffer.from(JSON.stringify(evidence)); claim.testEvidenceSha256 = sha256(x.testEvidenceBytes); x.claim = claim; return x; }
const run = x => { const { claim, testEvidenceBytes, ...facts } = x; return evaluate(facts, { claim, testEvidenceBytes }); };
// Structural pass only: mock/recorded facts can never be reported as authenticated provenance.
function accept(x, label) {
  const r = run(x);
  assert.deepEqual(r.errors, [], label); assert.equal(r.structuralChecksPassed, true, label);
  assert.equal(r.authenticatedProvenance, false, label); assert.equal(r.machineChecksPassed, false, label);
  assert.equal(r.technicalEvidenceComplete, false, label); assert.equal(r.approved, false, label); assert.deepEqual(r.machineVerifiedSuites, [], label);
  checks++; return r;
}
function refuse(x, pattern, label) {
  const r = run(x);
  assert.equal(r.structuralChecksPassed, false, label); assert.equal(r.technicalEvidenceComplete, false, label); assert.equal(r.approved, false, label);
  assert.ok(r.errors.some(error => pattern.test(error)), `${label}: expected ${pattern} in ${JSON.stringify(r.errors)}`); checks++; return r;
}

// ── 1. Real recorded run 36951283961: honest legacy fail-closed ─────────────
{
  const r = run(real());
  assert.deepEqual(r.errors, [
    'Job steps differ from the trusted workflow (mount-target check or whole-image root discovery missing, or a step did not succeed)',
    'Executed scripts/forge-source-topology.mjs differs from (or is absent in) the evidence source',
    'Executed scripts/forge-candidate-image-roots.mjs differs from (or is absent in) the evidence source',
    'Artifact lacks forge-image-roots.json: complete installed-root set cannot be derived',
    'Artifact lacks forge-image-mount-targets.json',
    'Unmounted image does not prove every proof mount target absent for this source and image']);
  assert.equal(r.authenticatedProvenance, false); assert.equal(r.approved, false);
  assert.equal(r.inventorySha256, '9b26d6c467879547de77b44152153dc37701799a09dd7f0229b9409291808a51');
  assert.deepEqual(r.image, { configId: 'sha256:a0b41f5fb84990cd0c3d341a44d81cd86414ed7c0b3284f61b1c3612a9a23532', manifestDigest: 'sha256:3c4bdb6bee266f7ce022639d4109f8ef10d06d8005d0ae95d7e7113c7221031e', platform: 'linux/arm64' });
  assert.equal(r.rawAudit['node-forge'][0].url, `https://github.com/advisories/${ADVISORY}`); // full audit stays visible
  checks++;
}
// ── 2. Non-vacuous controls: a coherent future run passes STRUCTURALLY only ─
accept(complete(), 'complete synthetic run');
accept(seal(complete(), callerPair(complete())), 'complete run with a truthful caller pair');
{ const x = complete(); x.git.head = 'e'.repeat(40); x.git.changedPaths = [`${PROVENANCE_DIR}pins.json`]; accept(x, 'HEAD differs only by the pin record'); }
{ const r = run(complete()); assert.ok(r.requiresParentDecision.some(item => /forge-suite/.test(item))); assert.ok(r.requiresParentDecision.some(item => /security review/.test(item))); assert.ok(r.requiresParentDecision.some(item => /structural check only/.test(item))); checks++; }
assert.equal(expectedRegressionRows().length, 321); checks++;

// GitHub clears Actions pull_requests after merge. The fallback still binds the
// exact source commit through authenticated commit->PR and PR metadata reads.
function mergedAssociation() {
  const x = complete();
  x.github.run.pull_requests = [];
  const pr = { number: x.pins.pullRequest, state: 'closed', merged: true,
    merge_commit_sha: 'a'.repeat(40),
    head: { ref: x.pins.headBranch, sha: 'b'.repeat(40), repo: { full_name: TRUSTED_WORKFLOW.repository, id: TRUSTED_WORKFLOW.repositoryId } },
    base: { ref: 'main', repo: { full_name: TRUSTED_WORKFLOW.repository, id: TRUSTED_WORKFLOW.repositoryId } } };
  x.github.pullRequest = pr;
  x.github.sourcePullRequests = [structuredClone(pr)];
  return x;
}
accept(mergedAssociation(), 'merged run with empty mutable Actions PR list and exact authenticated source association');
for (const [label, mutate] of [
  ['missing PR read', x => { delete x.github.pullRequest; }],
  ['missing source association', x => { x.github.sourcePullRequests = []; }],
  ['another PR association', x => { x.github.sourcePullRequests[0].number++; }],
  ['ambiguous source association', x => { x.github.sourcePullRequests.push(structuredClone(x.github.sourcePullRequests[0])); }],
  ['wrong PR number', x => { x.github.pullRequest.number++; }],
  ['unmerged PR', x => { x.github.pullRequest.merged = false; }],
  ['open PR', x => { x.github.pullRequest.state = 'open'; }],
  ['fork PR', x => { x.github.pullRequest.head.repo.full_name = 'fork/oxy'; }],
  ['foreign repository ID', x => { x.github.pullRequest.head.repo.id++; }],
  ['wrong branch', x => { x.github.pullRequest.head.ref = 'foreign'; }],
  ['wrong base', x => { x.github.pullRequest.base.ref = 'other'; }],
  ['foreign base repo', x => { x.github.pullRequest.base.repo.full_name = 'fork/oxy'; }],
  ['malformed merged SHA', x => { x.github.pullRequest.merge_commit_sha = 'invalid'; }],
  ['source association head mismatch', x => { x.github.sourcePullRequests[0].head.sha = 'c'.repeat(40); }],
  ['source association branch mismatch', x => { x.github.sourcePullRequests[0].head.ref = 'foreign'; }],
  ['source association merge mismatch', x => { x.github.sourcePullRequests[0].merge_commit_sha = 'c'.repeat(40); }],
  ['nonempty unrelated Actions association', x => { x.github.run.pull_requests = [{ number: x.pins.pullRequest + 1 }]; }],
  ['malformed Actions association list', x => { x.github.run.pull_requests = null; }],
]) { const x = mergedAssociation(); mutate(x); refuse(x, /Workflow run identity differs/, label); }

// ── 3. Coordinator acceptance regressions: BOTH caller manifest and test evidence changed coherently ─
{
  const x = complete(); const pair = callerPair(x);
  x.audit['synthetic-unreviewed-fixture'] = [{ url: 'https://example.invalid/TEST-UNREVIEWED', severity: 'high' }];
  pair.claim.rawAuditSha256 = pair.evidence.rawAuditSha256 = sha256(canonicalAudit(x.audit));
  refuse(seal(x, pair), /Whole raw audit differs from the reviewed baseline/, 'coherently changed caller audit and baseline');
}
{
  const x = complete(); const pair = callerPair(x);
  pair.claim.sourceHead = pair.evidence.sourceHead = '0'.repeat(40);
  Object.assign(pair.evidence.actualImage, { configId: `sha256:${'0'.repeat(64)}`, manifestDigest: `sha256:${'0'.repeat(64)}`, platform: 'linux/amd64', run: 1 });
  const r = refuse(seal(x, pair), /Caller manifest source differs/, 'coherently changed source and image assertions');
  assert.ok(r.errors.some(e => /Test evidence image\/run differs/.test(e))); checks++;
}
// Same, with the caller also rewriting the pins to match: the authenticated-source facts disagree.
{
  const x = complete(); x.pins.sourceSha = '81442f48fc8c5a7251dd4ae290e02c4afb1aa633';
  refuse(seal(x, callerPair(x)), /Workflow run identity differs/, 'pins re-pointed at the old receipt source');
}
// ── 4. Caller authority is never accepted ───────────────────────────────────
for (const [field, value] of [['independentSecurityReview', { reviewer: 'caller', reviewedPatchSha256: TRUSTED_BASELINE.patchSha256 }], ['approved', true], ['approval', 'granted']]) {
  const x = complete(); const pair = callerPair(x); pair.claim[field] = value;
  refuse(seal(x, pair), new RegExp(`field ${field} is not accepted`), `caller ${field}`);
}
{ const x = complete(); const pair = callerPair(x); pair.evidence.limits.policyApproved = true; refuse(seal(x, pair), /policyApproved:false/, 'caller policy approval'); }
{ const x = complete(); const pair = callerPair(x); pair.claim.status = 'APPROVED'; refuse(seal(x, pair), /CANDIDATE_UNAPPROVED/, 'caller status flip'); }
{ const x = complete(); const pair = callerPair(x); pair.evidence.suites['forge-suite'] = 'fail'; refuse(seal(x, pair), /suite: forge-suite/, 'caller failed suite'); }
{ const x = complete(); const pair = callerPair(x); seal(x, pair); x.claim.testEvidenceSha256 = 'a'.repeat(64); refuse(x, /test evidence hash/, 'evidence hash mismatch'); }
{ const x = complete(); const pair = callerPair(x); pair.claim.version = pair.evidence.version = '1.4.1'; delete pair.evidence.version; refuse(seal(x, pair), /advisory\/package\/version/, 'caller version'); }
{ const x = complete(); const pair = callerPair(x); pair.claim.patchSha256 = pair.evidence.patchSha256 = 'b'.repeat(64); refuse(seal(x, pair), /baseline differs from the trusted baseline/, 'caller patch hash pair'); }
{ const x = complete(); const pair = callerPair(x); pair.claim.intentionalDanglingSharpLinks = ARM_PRUNED_LINKS.slice(1); refuse(seal(x, pair), /exact eight/, 'caller seven omissions'); }

// ── 5. Baseline: audit, live GHSA, git source, lock ─────────────────────────
refuse(Object.assign(complete(), { audit: undefined }), /Missing action-time raw audit/, 'no audit');
{ const x = complete(); x.audit['node-forge'].push({ url: 'https://github.com/advisories/GHSA-new', severity: 'high', vulnerable_versions: '<=1.4.0' }); refuse(x, /new advisory fails/, 'second Forge advisory'); }
{ const x = complete(); x.audit['node-forge'][0].vulnerable_versions = '<=1.4.1'; refuse(x, /Whole raw audit differs/, 'changed advisory range'); }
{ const x = complete(); delete x.audit.qs; refuse(x, /Whole raw audit differs/, 'removed unrelated advisory'); }
{ const x = complete(); x.github.advisory.vulnerabilities[0].first_patched_version = { identifier: '1.4.1' }; refuse(x, /upstream fix now exists/, 'upstream fix published'); }
{ const x = complete(); x.github.advisory.withdrawn_at = '2026-10-02T00:00:00Z'; refuse(x, /Live GHSA record changed/, 'advisory withdrawn'); }
{ const x = complete(); x.git.clean = false; refuse(x, /not clean/, 'dirty checkout'); }
{ const x = complete(); x.git.head = 'e'.repeat(40); x.git.changedPaths = ['scripts/forge-remediation-proof-proposal.mjs', `${PROVENANCE_DIR}pins.json`]; refuse(x, /not current HEAD/, 'evidence for older code'); }
{ const x = complete(); x.git.head = 'e'.repeat(40); x.git.changedPaths = ['bun.lock']; refuse(x, /not current HEAD/, 'image input changed since source'); }
{ const x = complete(); x.git.head = 'e'.repeat(40); x.git.sourceIsAncestor = false; x.git.changedPaths = []; refuse(x, /not an ancestor/, 'unrelated HEAD'); }
{ const x = complete(); x.git.patchBytes = Buffer.concat([x.git.patchBytes, Buffer.from('\n')]); refuse(x, /Source patch differs/, 'patch changed'); }
{ const x = complete(); x.git.lockText += '\n    "x/node-forge": ["node-forge@1.3.3", "", {}, "sha512-x"],'; refuse(x, /exactly one patched node-forge/, 'second lock version'); }
{ const x = complete(); x.git.lockText = x.git.lockText.replace(TRUSTED_BASELINE.lockPatch, ''); refuse(x, /exactly one patched node-forge/, 'patch declaration removed'); }
{ const x = complete(); const h = JSON.parse(x.git.candidateHashes); h.files['lib/rsa.js'].candidateSha256 = 'c'.repeat(64); x.git.candidateHashes = JSON.stringify(h); refuse(x, /candidate-hashes.json diverges/, 'committed hashes changed'); }
// ── 6. Stale / replayed evidence ────────────────────────────────────────────
{ const x = complete(); x.now = '2026-10-17T00:00:00Z'; refuse(x, /Stale or replayed/, 'expired artifact'); }
{ const x = complete(); x.git.sourceCommitTime = '2026-10-02T02:00:00Z'; refuse(x, /Stale or replayed/, 'run predates source'); }
{ const x = complete(); x.github.artifact.expired = true; refuse(x, /Artifact identity/, 'artifact marked expired'); }
{ const x = complete(); x.pins.runId = 36950612959; x.pins.jobId = 1; refuse(seal(x, callerPair(x)), /Workflow run identity differs/, 'replay of the earlier receipt run'); }
{ const x = complete(); x.github.run.run_attempt = 2; refuse(x, /Workflow run identity differs/, 're-run attempt'); }

// ── 7. Workflow, job, architecture, artifact identity ───────────────────────
{ const x = complete(); x.github.run.path = '.github/workflows/ci.yml'; refuse(x, /Workflow run identity/, 'different workflow'); }
{ const x = complete(); x.github.run.workflow_id = 226529809; refuse(x, /Workflow run identity/, 'another non-null workflow id (CI/CD Pipeline)'); }
{ const x = complete(); x.github.run.workflow_id = null; refuse(x, /Workflow run identity/, 'null workflow id'); }
{ const x = complete(); x.github.run.conclusion = 'failure'; refuse(x, /Workflow run identity/, 'failed run'); }
{ const x = complete(); x.github.run.head_repository.full_name = 'fork/oxy'; refuse(x, /Workflow run identity/, 'fork run'); }
{ const x = complete(); x.github.job.labels = ['ubuntu-24.04']; refuse(x, /architecture differs/, 'x86 runner'); }
{ const x = complete(); x.github.job.steps[8].conclusion = 'skipped'; refuse(x, /Job steps differ/, 'skipped proof step'); }
{ const x = complete(); x.github.blobsAtMerge['.github/workflows/forge-candidate-image-proof.yml'] = 'd'.repeat(40); refuse(x, /Executed .*forge-candidate-image-proof.yml differs/, 'altered executed workflow'); }
{ const x = complete(); x.github.blobsAtMerge['scripts/forge-candidate-regression.cjs'] = 'd'.repeat(40); refuse(x, /Executed scripts\/forge-candidate-regression.cjs differs/, 'altered executed regression script'); }
{ const x = complete(); x.pins.workflowMergeSha = 'd'.repeat(40); refuse(x, /merge of the evidence source|Build provenance/, 'workflow ref re-pinned'); }
{ const x = complete(); x.github.mergeCommit.parents = [x.github.mergeCommit.parents[0], '0'.repeat(40)]; refuse(x, /merge of the evidence source/, 'merge of another source'); }
// Artifact bytes re-packed and re-pinned by the caller, GitHub's digest untouched: digest binding refuses.
{
  const x = repack(complete(), ({ entries }) => entries.set('forge-image-identity.txt', Buffer.from(String(entries.get('forge-image-identity.txt')).replace(/a0b41f5f/, '00000000'))));
  refuse(x, /Artifact identity\/digest differs/, 'image identity forged, digest not');
}
// Re-packed with GitHub's digest following too: semantic checks still refuse.
{ const x = repack(complete(), ({ entries }) => entries.set('forge-image-identity.txt', Buffer.from(String(entries.get('forge-image-identity.txt')).replace('"arm64"', '"amd64"'))), { api: true }); refuse(x, /not the ARM image/, 'amd64 image'); }
{ const x = repack(complete(), ({ json, put }) => { const m = json('forge-build-metadata.json'); m['containerimage.digest'] = `sha256:${'1'.repeat(64)}`; put('forge-build-metadata.json', m); }, { api: true }); refuse(x, /Build provenance/, 'manifest digest altered'); }
{ const x = repack(complete(), ({ json, put }) => { const m = json('forge-build-metadata.json'); m['buildx.build.provenance'].invocation.environment.github_run_id = '1'; put('forge-build-metadata.json', m); }, { api: true }); refuse(x, /Build provenance/, 'build bound to another run'); }
{ const x = repack(complete(), ({ json, put }) => { const m = json('forge-build-metadata.json'); m['buildx.build.provenance'].invocation.parameters.root.request.args['vcs:revision'] = '0'.repeat(40); put('forge-build-metadata.json', m); }, { api: true }); refuse(x, /Build provenance/, 'build of another source'); }
{ const x = complete(); x.pins.image.configId = `sha256:${'0'.repeat(64)}`; refuse(x, /Pinned image identity differs/, 'pinned image differs'); }
{ const x = repack(complete(), ({ put }) => put('extra.json', {}), { api: true }); refuse(x, /Unexpected artifact entry/, 'extra artifact entry'); }
{ const x = complete(); x.artifactZip = Buffer.from('not a zip'); refuse(x, /Artifact unreadable/, 'corrupt artifact'); }

// ── 8. Complete roots, versions, bytes, regressions, pruned links (digest follows: semantic refusal) ─
const unpatched = Object.fromEntries(FILES.map(name => [name, name === 'lib/rsa.js' ? 'fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50' : TRUSTED_BASELINE.files[name]]));
for (const [label, extra] of [['unpatched copy outside /app', { path: '/usr/local/lib/node_modules/node-forge', version: '1.4.0', files: unpatched }],
  ['patched copy outside /app', { path: '/usr/local/lib/node_modules/node-forge', version: '1.4.0', files: { ...TRUSTED_BASELINE.files } }],
  ['old version outside /app', { path: '/opt/tool/node_modules/node-forge', version: '1.3.3', files: unpatched }]]) {
  const x = repack(complete(), ({ json, put }) => put('forge-image-roots.json', rootsFor(json('forge-image-regression-proof.json'), [extra])), { api: true });
  refuse(x, /copy outside claimed roots/, label);
}
{ const x = repack(complete(), ({ json, put }) => { const r = rootsFor(json('forge-image-regression-proof.json')); r.excluded.push('/usr'); put('forge-image-roots.json', r); }, { api: true }); refuse(x, /not the trusted complete scan/, 'extra scan exclusion'); }
{ const x = repack(complete(), ({ json, put }) => { const r = rootsFor(json('forge-image-regression-proof.json')); r.excluded = ['/dev', '/proc', '/proof', '/sys']; put('forge-image-roots.json', r); }, { api: true }); refuse(x, /not the trusted complete scan/, 'whole /proof excluded'); }
{ const x = repack(complete(), ({ json, put }) => put('forge-image-roots.json', rootsFor(json('forge-image-regression-proof.json'), [{ path: '/proof/node_modules/node-forge', version: '1.4.0', files: { ...TRUSTED_BASELINE.files } }])), { api: true }); refuse(x, /copy outside claimed roots/, 'patched copy under /proof'); }
{ const x = repack(complete(), ({ json, put }) => { const r = rootsFor(json('forge-image-regression-proof.json')); r.root = '/app'; put('forge-image-roots.json', r); }, { api: true }); refuse(x, /not the trusted complete scan/, 'scan limited to /app'); }
{ const x = repack(complete(), ({ json, put }) => { const r = rootsFor(json('forge-image-regression-proof.json')); r.installRoots = ['/usr/local/lib']; put('forge-image-roots.json', r); }, { api: true }); refuse(x, /not the trusted complete scan/, 'roots without /app'); }
{ const x = repack(complete(), ({ json, put }) => { const r = rootsFor(json('forge-image-regression-proof.json')); r.forgeCopies = []; put('forge-image-roots.json', r); }, { api: true }); refuse(x, /copy outside claimed roots/, 'scan hides the /app copy'); }
// Coherently rewrite the image proof (inventory hash recomputed) and the root scan to match.
function rewriteProof(change) {
  return repack(complete(), ({ json, put }) => {
    const proof = json('forge-image-regression-proof.json'); change(proof);
    const copies = proof.copies; Object.defineProperty(copies, 'intentionalDanglingSharpLinks', { value: proof.intentionalDanglingSharpLinks });
    proof.inventorySha256 = inventoryHash(copies);
    put('forge-image-regression-proof.json', proof); put('forge-image-roots.json', rootsFor(proof));
  }, { api: true });
}
refuse(rewriteProof(p => { p.copies[0].version = '1.4.1'; }), /Unexpected version/, 'coherent version 1.4.1');
for (const name of FILES) refuse(rewriteProof(p => { p.copies[0].files[name] = 'e'.repeat(64); }), /unpatched distribution/, `coherent changed ${name}`);
refuse(rewriteProof(p => { delete p.copies[0].files['dist/forge.all.min.js']; }), /unpatched distribution/, 'missing bundle hash');
refuse(rewriteProof(p => { p.copies.push({ ...p.copies[0], realpath: '/app/packages/api/node_modules/node-forge' }); }), /one-to-one|regression matrix/, 'second copy without regressions');
refuse(rewriteProof(p => { p.copies[0].realpath = p.regressions[0].realpath = '/opt/node-forge'; }), /outside the trusted installed root/, 'copy outside /app');
refuse(rewriteProof(p => { p.regressions[0].rows[30].forgeAccepted = true; }), /regression matrix/, 'one malformed signature accepted');
refuse(rewriteProof(p => { p.regressions[0].rows = p.regressions[0].rows.filter(row => row.distribution !== 'forge.all.min.js'); p.regressions[0].count = 321; }), /regression matrix/, 'bundle rows dropped');
refuse(rewriteProof(p => { p.regressions[0].count = 320; }), /regression matrix/, 'count changed');
refuse(rewriteProof(p => { p.intentionalDanglingSharpLinks = ARM_PRUNED_LINKS.slice(1); }), /Image proof does not bind/, 'proof with seven omissions');
refuse(rewriteProof(p => { p.approved = true; }), /Image proof does not bind/, 'artifact claims approval');
{ const x = repack(complete(), ({ json, put }) => { const d = json('forge-image-dangling-links.json'); d.danglingLinks.pop(); put('forge-image-dangling-links.json', d); }, { api: true }); refuse(x, /exactly the eight reviewed/, 'seven dangling links'); }
{ const x = repack(complete(), ({ json, put }) => { const d = json('forge-image-dangling-links.json'); d.danglingLinks.push({ path: 'node_modules/node-forge', target: '../x', absoluteResolution: '/app/x', errorCode: 'ENOENT' }); put('forge-image-dangling-links.json', d); }, { api: true }); refuse(x, /exactly the eight reviewed/, 'extra dangling Forge link'); }

// ── Proof mount targets must be absent from the unmounted image ─────────────
const MOUNT = /every proof mount target absent/;
const withTargets = (m, api = true) => repack(complete(), ({ put }) => put('forge-image-mount-targets.json', m), { api });
refuse(withTargets(mountTargets(m => { m.targets[0].present = true; })), MOUNT, 'occupied /proof/scripts');
refuse(withTargets(mountTargets(m => { m.targets[2].present = true; })), MOUNT, 'symlink at /proof/patches (lstat sees it)');
refuse(withTargets(mountTargets(m => { m.targets.pop(); })), MOUNT, 'target /proof/patches not checked');
refuse(withTargets(mountTargets(m => { m.targets.push({ path: '/proof/extra', present: false }); })), MOUNT, 'extra target list');
refuse(withTargets(mountTargets(m => { m.mounts = 'scripts'; })), MOUNT, 'check ran with a mount');
refuse(withTargets(mountTargets(m => { m.sourceSha = '81442f48fc8c5a7251dd4ae290e02c4afb1aa633'; })), MOUNT, 'stale check from the receipt source');
refuse(withTargets(mountTargets(m => { m.imageId = `sha256:${'d'.repeat(64)}`; })), MOUNT, 'check of another image');
refuse(withTargets(mountTargets(m => { m.approval = true; })), MOUNT, 'check claims approval');
refuse(repack(complete(), ({ entries }) => entries.delete('forge-image-mount-targets.json'), { api: true }), /lacks forge-image-mount-targets.json/, 'missing mount-target artifact');
refuse(withTargets(mountTargets(m => { m.targets[1].present = true; }), false), /Artifact identity\/digest differs/, 'tampered check, GitHub digest unchanged');
{ const x = complete(); x.github.job.steps = x.github.job.steps.filter(step => !/mount targets/.test(step.name)); refuse(x, /Job steps differ/, 'mount-target step missing from the run'); }
{ const x = complete(); x.github.job.steps.find(step => /mount targets/.test(step.name)).conclusion = 'failure'; refuse(x, /Job steps differ/, 'mount-target step failed'); }
// Coherent caller spoof: the caller pair agrees with an occupied-target artifact; still refused.
{ const x = withTargets(mountTargets(m => { m.targets[0].present = true; })); refuse(seal(x, callerPair(x)), MOUNT, 'coherent caller spoof of an occupied target'); }
// The reviewed step runs before any proof mount, with no mounts, no network and a read-only root.
{
  const workflow = readFileSync(join(repo, '.github/workflows/forge-candidate-image-proof.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Verify proof mount targets are absent'), workflow.indexOf('- name: Record actual final-image dangling links'));
  assert.ok(workflow.indexOf('- name: Verify proof mount targets are absent') < workflow.indexOf('dst=/proof/'));
  assert.ok(!/--mount|--volume|-v /.test(step) && /--network none/.test(step) && /--read-only/.test(step) && /lstatSync/.test(step));
  for (const target of TRUSTED_WORKFLOW.mountTargets) assert.ok(workflow.includes(`dst=${target},readonly`) && step.includes(`"${target}"`), target);
  assert.equal(new Set([...workflow.matchAll(/dst=(\/proof\/[a-z]+)/g)].map(match => match[1])).size, TRUSTED_WORKFLOW.mountTargets.length);
  checks++;
}
// In-place byte mutation (buffers cannot be frozen) trips the pinned digest and baseline.
{ const x = complete(); const bytes = Buffer.from(x.artifactZip); x.artifactZip = bytes; bytes[bytes.length - 30] ^= 1; refuse(x, /Artifact/, 'artifact bytes mutated in place'); }
{ const x = complete(); const bytes = Buffer.from(x.git.patchBytes); x.git.patchBytes = bytes; bytes[0] ^= 1; refuse(x, /Source patch differs/, 'patch bytes mutated in place'); }
// ── 9. Authentication cannot be injected ────────────────────────────────────
{
  const forged = complete(); Object.freeze(forged);
  assert.equal(evaluate(forged).authenticatedProvenance, false); checks++;
  const scratch = mkdtempSync(join(tmpdir(), 'forge-collect-'));
  let fakeCalled = false;
  try { assert.throws(() => collect({ repoRoot: scratch, exec: () => { fakeCalled = true; return Buffer.from('{}'); } })); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
  assert.equal(fakeCalled, false, 'collect never uses a caller exec'); checks++;
  // Runtime program overrides are refused before anything executes or is marked authenticated.
  for (const override of [{ bun: '/bin/echo' }, { exec: () => Buffer.from('{}') }, { env: { PATH: '/tmp' } }]) {
    assert.throws(() => collect({ repoRoot: repo, ...override }), /accepts no runtime overrides/); checks++;
  }
  const source = readFileSync(join(repo, 'scripts/forge-remediation-proof-proposal.mjs'), 'utf8');
  assert.ok(!/process\.env\.BUN_BIN|process\.env\.PATH/.test(source), 'no environment-selected program'); checks++;
}
// ── 10. Whole-image root scanner (physical walk, fail closed on disguised Forge) ─
{
  const fs = mkdtempSync(join(tmpdir(), 'forge-roots-'));
  try {
    const pkg = (dir, manifest, forge = false) => {
      mkdirSync(join(fs, dir), { recursive: true });
      if (manifest !== undefined) writeFileSync(join(fs, dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      if (forge) for (const name of [...FILES, 'lib/forge.js']) { mkdirSync(join(fs, dir, name, '..'), { recursive: true }); writeFileSync(join(fs, dir, name), name); }
    };
    pkg('app', { name: 'app', version: '0.0.0' });
    pkg('app/node_modules/.bun/node-forge@1.4.0/node_modules/node-forge', { name: 'node-forge', version: '1.4.0' }, true);
    symlinkSync(join(fs, 'app/node_modules/.bun/node-forge@1.4.0/node_modules/node-forge'), join(fs, 'app/node_modules/node-forge'));
    pkg('app/node_modules/.bun/resolve@1/node_modules/resolve', { name: 'resolve', version: '1.0.0' });
    pkg('app/node_modules/.bun/resolve@1/node_modules/resolve/test/node_modules/fixture', '{not json'); // shipped fixture, not a slot
    pkg('proc/node_modules/node-forge', { name: 'node-forge', version: '0.0.1' }, true); // excluded virtual mount
    let r = scanRoots(fs);
    assert.deepEqual(r.forgeCopies.map(copy => copy.path), [join(fs, 'app/node_modules/.bun/node-forge@1.4.0/node_modules/node-forge')]);
    assert.deepEqual(r.installRoots, [join(fs, 'app')]); checks++;
    pkg('usr/local/lib/node_modules/npm/node_modules/node-forge', { name: 'node-forge', version: '1.3.3' }, true);
    r = scanRoots(fs);
    assert.equal(r.forgeCopies.length, 2); assert.ok(r.installRoots.includes(join(fs, 'usr/local/lib'))); checks++;
    rmSync(join(fs, 'usr'), { recursive: true });
    const disguise = (dir, manifest) => { pkg(dir, manifest, true); assert.throws(() => scanRoots(fs), /does not identify as node-forge|Unreadable package manifest|lacks a string/); rmSync(join(fs, dir.split('/')[0] === 'app' ? dir : dir.split('/')[0]), { recursive: true }); checks++; };
    disguise('opt/vendor/totally-not-forge', { name: 'renamed', version: '1.4.0' });
    disguise('opt/vendor/node-forge', { name: 'node-forge' });
    disguise('opt/vendor/forge-copy', '{broken');
    disguise('opt/vendor/forge-no-manifest', undefined);
    pkg('app/node_modules/broken-slot', '{broken'); assert.throws(() => scanRoots(fs), /Unreadable package manifest/); rmSync(join(fs, 'app/node_modules/broken-slot'), { recursive: true }); checks++;
    pkg('app/node_modules/@scope/nameless', { version: '1.0.0' }); assert.throws(() => scanRoots(fs), /lacks a string name\/version/); rmSync(join(fs, 'app/node_modules/@scope'), { recursive: true }); checks++;
    // Only the exact /proof/scripts bind mount is skipped; any other /proof content is image content.
    pkg('proof/scripts/node_modules/node-forge', { name: 'node-forge', version: '0.0.1' }, true);
    assert.equal(scanRoots(fs).forgeCopies.length, 1); checks++;
    pkg('proof/node_modules/node-forge', { name: 'node-forge', version: '1.4.0' }, true);
    pkg('proof/hashes/vendor/node-forge', { name: 'node-forge', version: '1.4.0' }, true);
    assert.deepEqual(scanRoots(fs).forgeCopies.map(copy => copy.path), [join(fs, 'app/node_modules/.bun/node-forge@1.4.0/node_modules/node-forge'), join(fs, 'proof/hashes/vendor/node-forge'), join(fs, 'proof/node_modules/node-forge')]);
    assert.ok(scanRoots(fs).installRoots.includes(join(fs, 'proof'))); checks++;
    rmSync(join(fs, 'proof'), { recursive: true });
    assert.equal(scanRoots(fs).forgeCopies.length, 1); checks++; // clean again: refusals were not vacuous
  } finally { rmSync(fs, { recursive: true, force: true }); }
}

// ── 11. Strict local inventory (unchanged defaults: exact eight receipt pairs, no generic skip) ─
const root=mkdtempSync(join(tmpdir(),'forge-proof-fixture-'));
try {
  function create(relative, version='1.4.0') {
    const dir=join(root,relative); mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'package.json'),JSON.stringify({name:'node-forge',version}));
    for(const name of FILES) { mkdirSync(join(dir,name,'..'),{recursive:true}); writeFileSync(join(dir,name),name); }
    return dir;
  }
  const first=create('node_modules/.bun/node-forge@1.4.0/node_modules/node-forge');
  create('packages/app/node_modules/node-forge');
  symlinkSync(first,join(root,'node_modules/node-forge'),'dir');
  assert.equal(inventory(root).length,2); checks++;
  for (const entry of ARM_PRUNED_LINKS) { mkdirSync(join(root,entry.path,'..'),{recursive:true}); symlinkSync(entry.target,join(root,entry.path)); }
  assert.throws(()=>inventory(root),/ENOENT/);checks++;
  const option={intentionalDanglingSharpLinks:structuredClone(ARM_PRUNED_LINKS)};
  const allowed=inventory(root,option);
  assert.equal(allowed.length,2);assert.deepEqual(allowed.intentionalDanglingSharpLinks,option.intentionalDanglingSharpLinks);checks++;
  assert.notEqual(inventoryHash(allowed),inventoryHash([...allowed]));checks++;
  const changed=structuredClone(option);changed.intentionalDanglingSharpLinks[0].target='wrong';assert.throws(()=>inventory(root,changed));checks++;
  assert.throws(()=>inventory(root,{intentionalDanglingSharpLinks:option.intentionalDanglingSharpLinks.slice(1)}));checks++;
  assert.throws(()=>inventory(root,{intentionalDanglingSharpLinks:[...option.intentionalDanglingSharpLinks,option.intentionalDanglingSharpLinks[0]]}));checks++;
  const forgeLink='packages/api/node_modules/node-forge-broken';symlinkSync('/missing/node-forge',join(root,forgeLink));
  assert.throws(()=>inventory(root,option));checks++;rmSync(join(root,forgeLink));
  const victim=ARM_PRUNED_LINKS[0];rmSync(join(root,victim.path));symlinkSync('../../node-forge@1.4.0/node_modules/node-forge',join(root,victim.path));
  assert.throws(()=>inventory(root,option));checks++;rmSync(join(root,victim.path));symlinkSync(victim.target,join(root,victim.path));
  rmSync(join(root,ARM_PRUNED_LINKS[7].path));assert.throws(()=>inventory(root,option));checks++;
  for(const entry of ARM_PRUNED_LINKS.slice(0,7)) rmSync(join(root,entry.path));
  writeFileSync(join(first,'dist/forge.min.js'),'modified');
  assert.notEqual(inventory(root)[0].files['dist/forge.min.js'],sha256('dist/forge.min.js')); checks++;
  // A renamed or version-less manifest cannot hide a Forge-shaped copy from the strict inventory.
  const hidden = create('packages/other/node_modules/vendored');
  writeFileSync(join(hidden, 'package.json'), JSON.stringify({ name: 'vendored', version: '1.4.0' }));
  assert.throws(() => inventory(root), /does not identify as node-forge/); checks++;
  writeFileSync(join(hidden, 'package.json'), JSON.stringify({ name: 'node-forge' }));
  assert.throws(() => inventory(root), /does not identify as node-forge/); checks++;
  rmSync(join(hidden, 'package.json'));
  assert.throws(() => inventory(root), /without manifest/); checks++;
  rmSync(hidden, { recursive: true });
  assert.equal(inventory(root).length, 2); checks++;
} finally { rmSync(root,{recursive:true,force:true}); }
console.log(`${checks} inert proof assertions passed; recorded/mock facts stay structural (never authenticated); approval remains false.`);
