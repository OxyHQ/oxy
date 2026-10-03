const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require(process.argv[2]);
const base = path.resolve(__dirname, '../../../docs/architecture/1519-consumer-rollout-preflight/execution');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'frontend-dispatch/manifest.json')));
const lots = JSON.parse(fs.readFileSync(path.join(base, 'lots.json'))).consumers;
for (const row of manifest.rows) {
  const wt = lots.find(x => x.repository === row.repository).worktree;
  const old = yaml.parse(fs.readFileSync(path.join(wt, row.workflow), 'utf8'), {uniqueKeys: true});
  const next = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../', row.template), 'utf8'), {uniqueKeys: true});
  assert.deepEqual(Object.keys(next.jobs), Object.keys(old.jobs));
  for (const [event, value] of Object.entries(old.on)) assert.deepEqual(next.on[event], value);
  for (const input of ['expected_sha', 'ci_run_id']) assert.equal(next.on.workflow_dispatch.inputs[input].required, true);
  for (const [name, job] of Object.entries(old.jobs)) {
    const after = next.jobs[name];
    assert.deepEqual(after.needs, job.needs);
    const existing = (after.steps || []).filter(x => x.name !== 'Verify manual release source and CI');
    assert.equal(existing.length, (job.steps || []).length);
    (job.steps || []).forEach((step, i) => {
      if (step.name === 'Decide which release path owns this commit') {
        assert.match(existing[i].run, /else\s+bash \.github\/scripts\/release-provenance.sh/);
      } else assert.deepEqual(existing[i], step);
    });
  }
  const gateJob = next.jobs.scope || next.jobs.verify || next.jobs.deploy || next.jobs['deploy-frontend'];
  assert.match(gateJob.if, /OXY_1519_ROLLOUT_HOLD != 'true'/);
  assert.match(gateJob.if, /refs\/heads\/main/);
  const firstGate = gateJob.steps.findIndex(x => x.name === 'Verify manual release source and CI');
  assert.ok(firstGate > 0);
  assert.equal(gateJob.permissions['actions'], 'read');
  for (const job of Object.values(next.jobs)) {
    for (const step of job.steps || []) {
      if (step.name === 'Verify manual release source and CI') {
        assert.equal(step.if, "github.event_name == 'workflow_dispatch'");
        assert.equal(step.env.EXPECTED_CI_WORKFLOW, row.ciWorkflow);
      }
    }
  }
  console.log(`${row.repository}: original triggers/jobs/steps and prerequisites preserved; manual provenance/hold valid`);
}
