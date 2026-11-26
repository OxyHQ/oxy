// node --test .github/actions/seldon-race/race.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  finishPlan,
  HOSTED,
  laneGroup,
  inScope,
  laneOf,
  pairs,
  parseNames,
  SELDON,
  shouldRetry,
  started,
  startDecision,
  verdict,
  winner,
  yields,
} from './race.mjs';

const LABEL = 'seldon-ci';
const T0 = Date.parse('2026-11-26T05:00:00Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString().replace('.000', '');
let nextId = 1;

// Jobs as the run-attempt jobs API returns them.
const queued = (name, lane, created = 0) => ({
  id: nextId++,
  name,
  labels: [lane === SELDON ? LABEL : 'ubuntu-latest'],
  status: 'queued',
  conclusion: null,
  created_at: at(created),
  started_at: at(created),
  runner_id: null,
  runner_name: null,
});
const running = (name, lane, startedAt, created = 0) => ({
  ...queued(name, lane, created),
  status: 'in_progress',
  started_at: at(startedAt),
  runner_id: 42,
  runner_name: `${lane}-runner-${nextId}`,
});
const done = (job, conclusion) => ({ ...job, status: 'completed', conclusion });
// A job cancelled before it had a runner, as GitHub reports it.
const cancelledQueued = (name, lane, created = 0) => ({
  ...done(queued(name, lane, created), 'cancelled'),
  runner_id: 0,
  runner_name: '',
});
const skippedJob = (name, lane) => ({ ...done(queued(name, lane), 'skipped'), runner_id: null });

test('laneGroup spells the group the workflow must use', () => {
  assert.equal(
    laneGroup({ runId: '123', attempt: '2', lane: SELDON, name: 'Tests (1/5)' }),
    'seldon-race-123-2-seldon-Tests (1/5)',
  );
});

test('laneOf: the label decides the lane', () => {
  assert.equal(laneOf(queued('a', SELDON), LABEL), SELDON);
  assert.equal(laneOf(queued('a', HOSTED), LABEL), HOSTED);
  assert.equal(laneOf(queued('a', SELDON), 'seldon-ci-offline-sim'), HOSTED);
  // Every slot class of the pool is a Seldon lane.
  const light = { ...queued('a', SELDON), labels: ['seldon-ci-light'] };
  assert.equal(laneOf(light, LABEL), SELDON);
  assert.equal(laneOf({ ...light, labels: ['ubuntu-24.04-arm'] }, LABEL), HOSTED);
});

test('started: a runner, not the status or started_at, says a job started', () => {
  assert.equal(started(queued('a', SELDON)), false);
  assert.equal(started(running('a', SELDON, 10)), true);
  assert.equal(started(done(running('a', SELDON, 10), 'success')), true);
  assert.equal(started(done(running('a', SELDON, 10), 'cancelled')), true);
  assert.equal(started(cancelledQueued('a', SELDON)), false);
  assert.equal(started(skippedJob('a', SELDON)), false);
});

test('pairs: every live Seldon lane, with its hosted twin once it exists', () => {
  const s1 = queued('Tests (1/5)', SELDON);
  const s2 = queued('Tests (2/5)', SELDON);
  const h1 = queued('Tests (1/5)', HOSTED);
  const other = queued('Android (legacy)', HOSTED);
  const gone = skippedJob('Build', SELDON);
  const skippedTwin = skippedJob('Tests (2/5)', HOSTED);
  assert.deepEqual(pairs([s1, s2, h1, other, gone, skippedTwin], LABEL), [
    { name: 'Tests (1/5)', seldon: s1, hosted: h1 },
    { name: 'Tests (2/5)', seldon: s2, hosted: undefined },
  ]);
});

test('startDecision: waits, then races a lane still queued after the delay', () => {
  const delayMs = 180_000;
  const jobs = [
    running('Tests (1/5)', SELDON, 30),
    queued('Tests (2/5)', SELDON, 0),
    queued('Android', HOSTED),
  ];
  assert.equal(
    startDecision({ jobs, label: LABEL, now: T0 + 179_000, since: T0, delayMs }),
    'wait',
  );
  assert.equal(
    startDecision({ jobs, label: LABEL, now: T0 + 180_000, since: T0, delayMs }),
    'race',
  );
});

test('startDecision: no race once every Seldon lane has started or ended', () => {
  const jobs = [
    running('Tests (1/5)', SELDON, 30),
    done(running('Tests (2/5)', SELDON, 40), 'success'),
    skippedJob('Build', SELDON),
    queued('Android', HOSTED),
  ];
  assert.equal(
    startDecision({ jobs, label: LABEL, now: T0 + 60_000, since: T0, delayMs: 180_000 }),
    'no-race',
  );
});

test('startDecision: a lane cancelled while queued is not waiting', () => {
  const jobs = [cancelledQueued('Tests (1/5)', SELDON)];
  assert.equal(
    startDecision({ jobs, label: LABEL, now: T0 + 999_000, since: T0, delayMs: 180_000 }),
    'no-race',
  );
});

test('startDecision: no Seldon lane yet waits, and none after the delay is no race', () => {
  const jobs = [queued('Android', HOSTED)];
  const since = T0 + 5_000;
  assert.equal(
    startDecision({ jobs, label: LABEL, now: since + 60_000, since, delayMs: 180_000 }),
    'wait',
  );
  assert.equal(
    startDecision({ jobs, label: LABEL, now: since + 180_000, since, delayMs: 180_000 }),
    'no-race',
  );
});

test('winner: the first to start, Seldon on a tie, null while neither has', () => {
  assert.equal(winner({ seldon: queued('a', SELDON), hosted: queued('a', HOSTED) }), null);
  assert.equal(winner({ seldon: queued('a', SELDON), hosted: undefined }), null);
  assert.equal(winner({ seldon: running('a', SELDON, 50), hosted: queued('a', HOSTED) }), SELDON);
  assert.equal(winner({ seldon: queued('a', SELDON), hosted: running('a', HOSTED, 200) }), HOSTED);
  assert.equal(
    winner({ seldon: running('a', SELDON, 250), hosted: running('a', HOSTED, 200) }),
    HOSTED,
  );
  assert.equal(
    winner({ seldon: running('a', SELDON, 200), hosted: running('a', HOSTED, 200) }),
    SELDON,
  );
  assert.equal(
    winner({
      seldon: done(running('a', SELDON, 10), 'success'),
      hosted: running('a', HOSTED, 200),
    }),
    SELDON,
  );
});

test('winner: a lane cancelled while queued never wins, though its started_at is early', () => {
  assert.equal(
    winner({ seldon: cancelledQueued('a', SELDON, 0), hosted: running('a', HOSTED, 200) }),
    HOSTED,
  );
});

test('finishPlan: undecided until every twin exists and every pair has started', () => {
  const ids = { label: LABEL, runId: '9', attempt: '1' };
  const s1 = running('Tests (1/5)', SELDON, 30);
  const s2 = queued('Tests (2/5)', SELDON);
  assert.deepEqual(finishPlan({ jobs: [s1, s2], ...ids }), {
    reap: [],
    undecided: ['Tests (1/5)', 'Tests (2/5)'],
  });
  const h1 = queued('Tests (1/5)', HOSTED, 200);
  const h2 = queued('Tests (2/5)', HOSTED, 200);
  assert.deepEqual(finishPlan({ jobs: [s1, s2, h1, h2], ...ids }), {
    reap: ['seldon-race-9-1-hosted-Tests (1/5)'],
    undecided: ['Tests (2/5)'],
  });
});

test('finishPlan: reaps each loser still queued or running, not one already done', () => {
  const ids = { label: LABEL, runId: '9', attempt: '1' };
  const jobs = [
    running('Tests (1/5)', SELDON, 30),
    running('Tests (1/5)', HOSTED, 220), // a late twin, sleeping in its guard
    queued('Tests (2/5)', SELDON),
    running('Tests (2/5)', HOSTED, 210), // hosted won
    done(running('Tests (3/5)', SELDON, 40), 'success'),
    done(running('Tests (3/5)', HOSTED, 230), 'success'), // the loser finished on its own
    queued('Android', HOSTED),
  ];
  assert.deepEqual(finishPlan({ jobs, ...ids }), {
    reap: ['seldon-race-9-1-hosted-Tests (1/5)', 'seldon-race-9-1-seldon-Tests (2/5)'],
    undecided: [],
  });
});

test('finishPlan: nothing raced, nothing to do', () => {
  assert.deepEqual(
    finishPlan({ jobs: [queued('Android', HOSTED)], label: LABEL, runId: '9', attempt: '1' }),
    {
      reap: [],
      undecided: [],
    },
  );
});

test('yields: only a lane whose twin started first', () => {
  const s = running('Tests (1/5)', SELDON, 30);
  const lateTwin = running('Tests (1/5)', HOSTED, 220);
  assert.equal(yields({ jobs: [s, lateTwin], label: LABEL, jobId: lateTwin.id }), true);
  assert.equal(yields({ jobs: [s, lateTwin], label: LABEL, jobId: s.id }), false);

  const lateSeldon = running('Tests (2/5)', SELDON, 400);
  const h = running('Tests (2/5)', HOSTED, 210);
  assert.equal(yields({ jobs: [lateSeldon, h], label: LABEL, jobId: lateSeldon.id }), true);
  assert.equal(yields({ jobs: [lateSeldon, h], label: LABEL, jobId: h.id }), false);
});

test('yields: runs when there is no twin, the twin is queued or skipped, or the job is unknown', () => {
  const s = running('Tests (1/5)', SELDON, 30);
  assert.equal(yields({ jobs: [s], label: LABEL, jobId: s.id }), false);
  assert.equal(
    yields({ jobs: [s, queued('Tests (1/5)', HOSTED, 200)], label: LABEL, jobId: s.id }),
    false,
  );
  assert.equal(
    yields({ jobs: [s, skippedJob('Tests (1/5)', HOSTED)], label: LABEL, jobId: s.id }),
    false,
  );
  assert.equal(yields({ jobs: [s], label: LABEL, jobId: -1 }), false);
  const hostedAlone = running('Android', HOSTED, 10);
  assert.equal(yields({ jobs: [hostedAlone], label: LABEL, jobId: hostedAlone.id }), false);
});

test('yields: a twin that started first and already finished still wins', () => {
  const h = done(running('Tests (1/5)', HOSTED, 210), 'success');
  const s = running('Tests (1/5)', SELDON, 500);
  assert.equal(yields({ jobs: [s, h], label: LABEL, jobId: s.id }), true);
});

test('verdict: a cancelled loser passes; a failure or no success does not', () => {
  const jobs = [
    // Seldon won, hosted reaped.
    done(running('Tests (1/5)', SELDON, 30), 'success'),
    cancelledQueued('Tests (1/5)', HOSTED, 200),
    // Hosted won, Seldon reaped while queued.
    cancelledQueued('Tests (2/5)', SELDON),
    done(running('Tests (2/5)', HOSTED, 210), 'success'),
    // The winner failed.
    done(running('Tests (3/5)', SELDON, 30), 'failure'),
    cancelledQueued('Tests (3/5)', HOSTED, 200),
    // Both cancelled: nothing passed.
    done(running('Tests (4/5)', SELDON, 30), 'cancelled'),
    cancelledQueued('Tests (4/5)', HOSTED, 200),
    // No race: the Seldon lane alone, its twin skipped.
    done(running('Tests (5/5)', SELDON, 30), 'success'),
    skippedJob('Tests (5/5)', HOSTED),
    // Not raced: never judged.
    done(running('Android', HOSTED, 10), 'failure'),
  ];
  assert.deepEqual(verdict(jobs, LABEL), {
    'Tests (1/5)': true,
    'Tests (2/5)': true,
    'Tests (3/5)': false,
    'Tests (4/5)': false,
    'Tests (5/5)': true,
  });
});

test('verdict: a timed-out or still-running lane fails its name', () => {
  const jobs = [
    done(running('Build', SELDON, 30), 'success'),
    done(running('Build', HOSTED, 200), 'timed_out'),
    done(running('Parity', SELDON, 30), 'success'),
    running('Parity', HOSTED, 200),
  ];
  assert.deepEqual(verdict(jobs, LABEL), { Build: false, Parity: false });
});

// The rescue: a hosted job of the same name that reruns a Seldon lane's work
// once that lane failed. It is created only after its Seldon lane completed.
test('pairs: a late rescue of the same name never stands in for the twin', () => {
  const s = done(running('Tests (1/5)', SELDON, 30), 'failure');
  const twin = cancelledQueued('Tests (1/5)', HOSTED, 200);
  const rescue = running('Tests (1/5)', HOSTED, 400, 390);
  // Listed before the twin, as the API may order them: the earliest still wins.
  assert.deepEqual(pairs([rescue, s, twin], LABEL), [
    { name: 'Tests (1/5)', seldon: s, hosted: twin },
  ]);
  // A tie on created_at goes to the lower id, the job GitHub created first.
  const sameSecond = { ...rescue, created_at: twin.created_at };
  assert.equal(pairs([sameSecond, s, twin], LABEL)[0].hosted, twin);
});

test('finishPlan and yields: a late rescue changes nothing', () => {
  const ids = { label: LABEL, runId: '9', attempt: '1' };
  const s = done(running('Build', SELDON, 30), 'failure');
  const twin = running('Build', HOSTED, 220, 200); // sleeping in its guard
  const rescue = queued('Build', HOSTED, 300);
  assert.deepEqual(finishPlan({ jobs: [rescue, s, twin], ...ids }), {
    reap: ['seldon-race-9-1-hosted-Build'],
    undecided: [],
  });
  assert.equal(yields({ jobs: [rescue, s, twin], label: LABEL, jobId: twin.id }), true);
});

test('verdict: a failed Seldon lane is excused by a hosted success, never a hosted failure', () => {
  const jobs = [
    // No race: the Seldon lane failed on the network, its rescue passed.
    done(running('Tests (1/5)', SELDON, 30), 'failure'),
    skippedJob('Tests (1/5)', HOSTED),
    done(running('Tests (1/5)', HOSTED, 400, 390), 'success'),
    // Raced: Seldon won and failed, the twin was reaped, the rescue passed.
    done(running('Tests (2/5)', SELDON, 30), 'failure'),
    cancelledQueued('Tests (2/5)', HOSTED, 200),
    done(running('Tests (2/5)', HOSTED, 400, 390), 'success'),
    // A genuine failure fails again in the rescue.
    done(running('Tests (3/5)', SELDON, 30), 'failure'),
    skippedJob('Tests (3/5)', HOSTED),
    done(running('Tests (3/5)', HOSTED, 400, 390), 'failure'),
    // Both lanes ran and the hosted twin failed: Seldon's success does not excuse it.
    done(running('Tests (4/5)', SELDON, 30), 'success'),
    done(running('Tests (4/5)', HOSTED, 200), 'failure'),
    // A Seldon lane that timed out, rescued.
    done(running('Tests (5/5)', SELDON, 30), 'timed_out'),
    done(running('Tests (5/5)', HOSTED, 400, 390), 'success'),
    // A rescue that was cancelled rescues nothing.
    done(running('Build', SELDON, 30), 'failure'),
    done(running('Build', HOSTED, 400, 390), 'cancelled'),
  ];
  assert.deepEqual(verdict(jobs, LABEL), {
    'Tests (1/5)': true,
    'Tests (2/5)': true,
    'Tests (3/5)': false,
    'Tests (4/5)': false,
    'Tests (5/5)': true,
    Build: false,
  });
});

test('verdict: a family that ran hosted only is judged too, so a hosted failure is never excused', () => {
  const jobs = [
    // A re-run attempt: every lane hosted, the job failed and a rescue passed.
    done(running('Tests (1/5)', HOSTED, 30), 'failure'),
    done(running('Tests (1/5)', HOSTED, 400, 390), 'success'),
    // One live job of a name, its twins skipped: not a race, not judged here.
    done(running('Lint', HOSTED, 30), 'failure'),
    skippedJob('Lint', HOSTED),
  ];
  assert.deepEqual(verdict(jobs, LABEL), { 'Tests (1/5)': false });
});

// Waves: a second race covers jobs that need the first wave's, by name.
test('parseNames and inScope: exact names, a matrix by its prefix, empty covers all', () => {
  const names = parseNames('  Build API\n\nTests\n');
  assert.deepEqual(names, ['Build API', 'Tests']);
  assert.equal(inScope(names)(queued('Build API', SELDON)), true);
  assert.equal(inScope(names)(queued('Tests (2/5)', SELDON)), true);
  assert.equal(inScope(names)(queued('Testsuite', SELDON)), false);
  assert.equal(inScope(names)(queued('Lint & Test', SELDON)), false);
  assert.equal(inScope(parseNames(''))(queued('Lint & Test', SELDON)), true);
  assert.deepEqual(parseNames(undefined), []);
});

test('startDecision and finishPlan: a wave sees only its own lanes', () => {
  const wave2 = ['Build API'];
  const firstWave = [
    done(running('Lint & Test', SELDON, 30), 'success'), // no twin: the first race did not run
  ];
  // The second wave's lanes are not listed yet: wait, not "no race".
  assert.equal(
    startDecision({
      jobs: firstWave,
      label: LABEL,
      now: T0 + 60_000,
      since: T0,
      delayMs: 180_000,
      names: wave2,
    }),
    'wait',
  );
  const build = queued('Build API', SELDON, 700);
  assert.equal(
    startDecision({
      jobs: [...firstWave, build],
      label: LABEL,
      now: T0 + 880_000,
      since: T0 + 700_000,
      delayMs: 180_000,
      names: wave2,
    }),
    'race',
  );
  // Finish waits for the second wave's twin, never for the first wave's.
  const ids = { label: LABEL, runId: '9', attempt: '1', names: wave2 };
  assert.deepEqual(finishPlan({ jobs: [...firstWave, build], ...ids }), {
    reap: [],
    undecided: ['Build API'],
  });
  const twin = running('Build API', HOSTED, 890, 885);
  assert.deepEqual(finishPlan({ jobs: [...firstWave, build, twin], ...ids }), {
    reap: ['seldon-race-9-1-seldon-Build API'],
    undecided: [],
  });
});

test('retry: a failed pull-request run whose failure ran on Seldon re-runs once', () => {
  const run = { event: 'pull_request', conclusion: 'failure', run_attempt: 1 };
  const seldonFail = [{ conclusion: 'failure', labels: ['seldon-ci'] }];
  const hostedFail = [{ conclusion: 'failure', labels: ['ubuntu-latest'] }];
  assert.equal(shouldRetry(run, seldonFail, 'seldon-ci'), true);
  assert.equal(shouldRetry(run, hostedFail, 'seldon-ci'), false);
  assert.equal(shouldRetry({ ...run, run_attempt: 2 }, seldonFail, 'seldon-ci'), false);
  assert.equal(shouldRetry({ ...run, event: 'merge_group' }, seldonFail, 'seldon-ci'), false);
  assert.equal(shouldRetry({ ...run, conclusion: 'success' }, seldonFail, 'seldon-ci'), false);
  // A rescue (or a twin) of that name already ran hosted in the run: no retry.
  const failed = { name: 'Build', status: 'completed', conclusion: 'failure' };
  const seldon = { ...failed, labels: ['seldon-ci'] };
  const light = { ...failed, labels: ['seldon-ci-light'] };
  const rescue = (conclusion) => ({ ...failed, conclusion, labels: ['ubuntu-latest'] });
  assert.equal(shouldRetry(run, [seldon, rescue('success')], 'seldon-ci'), false);
  assert.equal(shouldRetry(run, [seldon, rescue('failure')], 'seldon-ci'), false);
  assert.equal(shouldRetry(run, [seldon, rescue('skipped')], 'seldon-ci'), true);
  assert.equal(shouldRetry(run, [seldon, rescue('cancelled')], 'seldon-ci'), true);
  assert.equal(shouldRetry(run, [light], 'seldon-ci'), true);
});
