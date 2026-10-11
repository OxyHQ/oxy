import assert from 'node:assert/strict';
import {
  inspectFinalImageFacts,
  selectFinalInspection,
  listFinalPages,
  assertFinalWaitDeadline,
  checkFinalProofFreshness,
} from './forge-final-image-collector.mjs';
import { readZip, sha256 } from './forge-remediation-proof-proposal.mjs';
import { fixture, zip, head } from './forge-final-image-test-fixture.mjs';
let count = 1;
const good = fixture();
const positive = inspectFinalImageFacts(good);
assert.equal(positive.structurallyEligible, true, positive.errors.join('\n'));
count++;
assert.equal(positive.authenticatedProvenance, false);
count++;
assert.equal(positive.machineChecksPassed, false);
count++;
assert.equal(positive.authorized, false);
count++;
const state = (x) =>
  selectFinalInspection(
    [x.producer.run],
    [x.producer.job],
    [x.artifact, x.archiveArtifact],
    x.execution.head,
  );
assert.equal(state(good).state, 'ready', 'inspection can complete before workflow/publisher');
count++;
for (const [name, mutate] of [
  [
    'skipped scan step',
    (x) => {
      x.producer.job.steps[6].conclusion = 'skipped';
    },
  ],
  [
    'extra executed step',
    (x) => {
      x.producer.job.steps.push({ name: 'arbitrary extra step', conclusion: 'success' });
    },
  ],
  [
    'raw artifact tampered',
    (x) => {
      x.proofZipBytes = Buffer.from('fake zip');
    },
  ],
  [
    'metadata cannot substitute actual archive verification',
    (x) => {
      delete x.archiveVerification;
    },
  ],
  [
    'streaming archive digest differs',
    (x) => {
      x.archiveVerification.archiveSha256 = 'f'.repeat(64);
    },
  ],
  [
    'transport archive absent',
    (x) => {
      x.archiveArtifact = null;
    },
  ],
  [
    'transport artifact wrong source',
    (x) => {
      x.archiveArtifact.workflow_run.head_sha = 'f'.repeat(40);
    },
  ],
  [
    'old PR context',
    (x) => {
      x.producer.run.event = 'pull_request';
    },
  ],
  [
    'missing declared blob',
    (x) => {
      delete x.producer.executedBlobs.source['Dockerfile'];
    },
  ],
  [
    'image digest replaced',
    (x) => {
      x.artifact.digest = `sha256:${'f'.repeat(64)}`;
    },
  ],
]) {
  const x = fixture();
  mutate(x);
  const r = inspectFinalImageFacts(x);
  assert.equal(r.structurallyEligible, false, name);
  assert.equal(r.machineChecksPassed, false);
  count += 2;
}
for (const [name, mutate] of [
  [
    'stock distribution hidden in inventory',
    (entries) => {
      const x = JSON.parse(entries.get('forge-image-regression-proof.json'));
      x.copies[0].files['lib/rsa.js'] = 'f'.repeat(64);
      entries.set('forge-image-regression-proof.json', Buffer.from(JSON.stringify(x)));
    },
  ],
  [
    'different executed workflow SHA',
    (entries) => {
      const x = JSON.parse(entries.get('forge-queue-execution.json'));
      x.workflowSha = 'f'.repeat(40);
      entries.set('forge-queue-execution.json', Buffer.from(JSON.stringify(x)));
    },
  ],
  [
    'regression row missing',
    (entries) => {
      const x = JSON.parse(entries.get('forge-image-regression-proof.json'));
      x.regressions[0].rows.pop();
      entries.set('forge-image-regression-proof.json', Buffer.from(JSON.stringify(x)));
    },
  ],
  [
    'unknown extra artifact member',
    (entries) => {
      entries.set('unexpected.json', Buffer.from('{}'));
    },
  ],
]) {
  const x = fixture();
  const entries = readZip(x.proofZipBytes);
  mutate(entries);
  x.proofZipBytes = zip(entries);
  x.artifact.digest = `sha256:${sha256(x.proofZipBytes)}`;
  x.artifact.size_in_bytes = x.proofZipBytes.length;
  const r = inspectFinalImageFacts(x);
  assert.equal(r.structurallyEligible, false, name);
  assert.equal(r.authorized, false);
  count += 2;
}
{
  const x = fixture();
  x.producer.job.status = 'in_progress';
  assert.equal(state(x).state, 'pending');
  count++;
}
{
  const x = fixture();
  x.producer.job.conclusion = 'failure';
  assert.equal(state(x).state, 'failed');
  count++;
}
{
  const x = fixture();
  x.producer.run.event = 'pull_request';
  assert.equal(state(x).state, 'pending');
  count++;
}
{
  const x = fixture();
  x.producer.run.status = 'completed';
  assert.equal(selectFinalInspection([x.producer.run], [], [], head).state, 'failed');
  count++;
}
// Actions can relabel a carried successful job with the newest attempt. The
// old transport remains attempt1 and cannot authorize a publish-only attempt2.
{
  const prior = fixture(),
    carried = fixture();
  carried.producer.run.run_attempt = 2;
  carried.producer.job.run_attempt = 2;
  assert.equal(state(carried).state, 'pending');
  count++;
  assert.equal(inspectFinalImageFacts(carried).structurallyEligible, false);
  count++;
  // Relabeling metadata alone cannot replace the producing nonce inside the ZIP.
  carried.artifact.name = `forge-queue-proof-${head}-123-2`;
  carried.archiveArtifact.name = `forge-queue-oci-${head}-123-2`;
  assert.equal(inspectFinalImageFacts(carried).structurallyEligible, false);
  count++;
  const entries = readZip(carried.proofZipBytes);
  const execution = JSON.parse(entries.get('forge-queue-execution.json'));
  execution.runAttempt = '2';
  entries.set('forge-queue-execution.json', Buffer.from(JSON.stringify(execution)));
  carried.proofZipBytes = zip(entries);
  carried.artifact.digest = `sha256:${sha256(carried.proofZipBytes)}`;
  carried.artifact.size_in_bytes = carried.proofZipBytes.length;
  assert.equal(inspectFinalImageFacts(carried).structurallyEligible, true);
  count++;
  const chosen = selectFinalInspection(
    [carried.producer.run],
    [carried.producer.job],
    [prior.artifact, prior.archiveArtifact, carried.artifact, carried.archiveArtifact],
    head,
  );
  assert.equal(chosen.state, 'ready');
  assert.equal(chosen.artifact.name, carried.artifact.name);
  count += 2;
  carried.archiveArtifact.name = prior.archiveArtifact.name;
  assert.equal(inspectFinalImageFacts(carried).structurallyEligible, false);
  count++;
}
const forged = { ...fixture(), authenticatedProvenance: true, approved: true };
assert.equal(inspectFinalImageFacts(forged).machineChecksPassed, false);
count++;
{
  const x = fixture();
  const dup = { ...x.artifact, id: 999 };
  assert.equal(
    selectFinalInspection(
      [x.producer.run],
      [x.producer.job],
      [x.artifact, dup, x.archiveArtifact],
      head,
    ).state,
    'failed',
  );
  count++;
}
{
  const x = fixture();
  assert.equal(
    selectFinalInspection(
      [x.producer.run],
      [x.producer.job, { ...x.producer.job }],
      [x.artifact, x.archiveArtifact],
      head,
    ).state,
    'failed',
  );
  count++;
}
{
  const x = fixture();
  x.producer.job.run_attempt = 2;
  assert.equal(state(x).state, 'pending');
  count++;
}
{
  let page = 0;
  const rows = listFinalPages(
    (path) => {
      page++;
      assert.match(path, /per_page=100&page=/);
      return { artifacts: page === 1 ? Array(100).fill({ id: 1 }) : [{ id: 2 }] };
    },
    'fixture?head_sha=synthetic',
    'artifacts',
  );
  assert.equal(rows.length, 101);
  assert.equal(page, 2);
  count += 2;
}
assert.throws(
  () => listFinalPages(() => ({ artifacts: Array(100).fill({}) }), 'fixture', 'artifacts'),
  /2000-record/,
);
count++;
assert.throws(
  () => listFinalPages(() => ({ artifacts: null }), 'fixture', 'artifacts'),
  /Malformed/,
);
count++;
assertFinalWaitDeadline(9, 10);
count++;
assert.throws(() => assertFinalWaitDeadline(10, 10), /wait expired/);
count++;
const decision = {
  schemaVersion: 1,
  status: 'ACTIVE',
  targetSourceHead: head,
  expiresAt: '2026-10-02T12:30:00.000Z',
  authorizationRecord: {
    channel: 'explicit-user-session',
    reference: 'SYNTHETIC CLOCK FIXTURE ONLY',
    instructionSha256: 'a'.repeat(64),
    recordedAt: '2026-10-02T11:00:00.000Z',
  },
  independentEvidence: { sourceHead: head, proofSha256: 'a'.repeat(64) },
};
for (const phase of ['wait', 'streaming', 'CI wait']) {
  const artifacts = [good.artifact, good.archiveArtifact];
  const start = checkFinalProofFreshness(decision, head, artifacts, '2026-10-02T12:00:00.000Z');
  assert.equal(start.valid, true);
  count++;
  let publications = 0;
  const finish = checkFinalProofFreshness(decision, head, artifacts, '2026-10-02T12:30:00.000Z');
  if (finish.valid) publications++;
  assert.equal(finish.valid, false, `Expiry during ${phase}`);
  assert.equal(publications, 0);
  count += 2;
}
for (const index of [0, 1]) {
  const artifacts = structuredClone([good.artifact, good.archiveArtifact]);
  artifacts[index].expires_at = '2026-10-02T12:20:00.000Z';
  assert.equal(
    checkFinalProofFreshness(decision, head, artifacts, '2026-10-02T12:00:00.000Z').valid,
    true,
  );
  count++;
  assert.equal(
    checkFinalProofFreshness(decision, head, artifacts, '2026-10-02T12:20:00.000Z').valid,
    false,
  );
  count++;
}
console.log(
  `${count} final-image collector/real-scan-content assertions pass on DERIVED SYNTHETIC queue context; no authenticated queue or publication claimed.`,
);
