// Races a heavy CI job between Seldon's `seldon-ci` pool and a GitHub-hosted
// twin (docs/engineering/build-and-deploy.md#ci-on-seldon).
//
// Every raced job has a twin of the same display name on a hosted runner. Both
// lanes sit in their own job-level concurrency group, `laneGroup()`, so queuing
// any job into a lane's group with cancel-in-progress cancels that lane alone
// (GitHub has no API that cancels a single job). The modes, one per step:
//
//   start    Seldon lanes still unstarted `delay` seconds after they were
//            queued? Then `race=true` and the hosted twins queue.
//   guard    the first step of each lane: a lane that starts after its twin
//            sleeps until `finish` cancels it, so it never does the work twice.
//   finish   polls until every pair has a lane running; the one that started
//            first wins (a tie goes to Seldon) and `reap` lists the losers'
//            groups, which the reap job queues into.
//   verdict  per job name: passed when a lane succeeded and no hosted lane
//            failed. A cancelled loser is never a failure, and a failed Seldon
//            lane is excused by a hosted lane that succeeded: its twin, or its
//            rescue, a hosted job of the same name that reruns the work
//            whenever a Seldon lane failed (the house network drops
//            connections), and that fails again on a genuine failure.
//
// It runs as a node24 JavaScript action, on the runner's own Node: Seldon's VM
// image has none, and the guard runs before setup-node. It reads only this
// run's jobs, with the job's GITHUB_TOKEN (actions: read).

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SELDON = 'seldon';
export const HOSTED = 'hosted';

/** The lane's job-level concurrency group; the workflow must spell it exactly so. */
export function laneGroup({ runId, attempt, lane, name }) {
  return `seldon-race-${runId}-${attempt}-${lane}-${name}`;
}

/**
 * A lane is a Seldon lane when one of its labels starts with `label`, so the
 * pool's slot classes (`seldon-ci`, `seldon-ci-light`) all race.
 */
export const laneOf = (job, label) =>
  job.labels.some((l) => l.startsWith(label)) ? SELDON : HOSTED;

const skipped = (job) => job.status === 'completed' && job.conclusion === 'skipped';

/**
 * Has the job had a runner? A job cancelled while queued is `completed` with
 * `runner_id` 0 and `started_at` equal to `created_at`, so neither status nor
 * started_at alone says it ran.
 */
export const started = (job) =>
  job.status === 'in_progress' || (job.status === 'completed' && job.runner_id > 0);

const waiting = (job) => job.status !== 'completed' && !started(job);

/** The live (not skipped) jobs on the Seldon label. */
const seldonLanes = (jobs, label) => jobs.filter((j) => !skipped(j) && laneOf(j, label) === SELDON);

/**
 * The `names` input: the display names one start/finish pair races, one per
 * line; `X` also covers a matrix's `X (...)`. Empty races every Seldon lane.
 * A workflow whose raced jobs come in waves (some need others) gives each
 * wave its own start and finish, so neither waits on the other's lanes.
 */
export function parseNames(value) {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export const inScope = (names) => (job) =>
  names.length === 0 || names.some((n) => job.name === n || job.name.startsWith(`${n} (`));

const createdOrder = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id;

/**
 * Every Seldon lane by name, as { name, seldon, hosted }; hosted is undefined
 * until its twin exists. The twin is the earliest live hosted job of that name:
 * a rescue of the same name is created only once its Seldon lane completed,
 * after the twin, so it never stands in for the twin.
 */
export function pairs(jobs, label) {
  const hostedLanes = jobs
    .filter((j) => !skipped(j) && laneOf(j, label) === HOSTED)
    .sort(createdOrder);
  return seldonLanes(jobs, label).map((seldon) => ({
    name: seldon.name,
    seldon,
    hosted: hostedLanes.find((j) => j.name === seldon.name),
  }));
}

/**
 * start: 'race', 'no-race' or 'wait' for the Seldon lanes as they stand at
 * `now`. `since` is when the start step began: Seldon lanes that never show
 * up within `delayMs` of it (all skipped, say) mean no race.
 */
export function startDecision({ jobs, label, now, since, delayMs, names = [] }) {
  const lanes = seldonLanes(jobs, label).filter(inScope(names));
  if (lanes.length === 0) return now - since >= delayMs ? 'no-race' : 'wait';
  const queued = lanes.filter(waiting);
  if (queued.length === 0) return 'no-race';
  if (queued.some((j) => now - Date.parse(j.created_at) >= delayMs)) return 'race';
  return 'wait';
}

/** The lane that started first (a tie goes to Seldon), or null while neither has. */
export function winner({ seldon, hosted }) {
  const at = (job) => (job && started(job) ? Date.parse(job.started_at) : Infinity);
  const s = at(seldon);
  const h = at(hosted);
  if (s === Infinity && h === Infinity) return null;
  return s <= h ? SELDON : HOSTED;
}

/**
 * finish: `reap`, the groups of the losers still running or queued, and
 * `undecided`, the names whose twin has not appeared yet or whose lanes have
 * both not started. Finish waits while anything is undecided.
 */
export function finishPlan({ jobs, label, runId, attempt, names = [] }) {
  const reap = [];
  const undecided = [];
  for (const pair of pairs(jobs, label).filter((p) => inScope(names)(p.seldon))) {
    const won = pair.hosted ? winner(pair) : null;
    if (!won) {
      undecided.push(pair.name);
      continue;
    }
    const lane = won === SELDON ? HOSTED : SELDON;
    if (pair[lane].status !== 'completed')
      reap.push(laneGroup({ runId, attempt, lane, name: pair.name }));
  }
  return { reap, undecided };
}

/** guard: does this job (by id) yield to a twin that started first? */
export function yields({ jobs, label, jobId }) {
  const me = jobs.find((j) => j.id === jobId);
  if (!me) return false;
  const pair = pairs(jobs, label).find((p) => p.name === me.name);
  if (!pair?.hosted) return false;
  const won = winner(pair);
  return won !== null && won !== laneOf(me, label);
}

const PASSING = new Set(['success', 'cancelled', 'skipped']);

/**
 * The names the verdict judges: every Seldon lane's, and every name that more
 * than one live job carries (a twin or a rescue of a lane that ran hosted).
 */
function judgedNames(jobs, label) {
  const names = new Set(seldonLanes(jobs, label).map((j) => j.name));
  const live = new Map();
  for (const j of jobs.filter((j) => !skipped(j))) live.set(j.name, (live.get(j.name) ?? 0) + 1);
  for (const [name, count] of live) if (count > 1) names.add(name);
  return [...names];
}

/**
 * verdict: { name: passed } for every judged name. Passed when a lane of that
 * name succeeded and no hosted lane ended in anything but success, cancelled
 * or skipped. A cancelled loser is fine, and so is a failed Seldon lane, which
 * the success of its hosted twin or rescue excuses; a failed hosted lane is
 * never excused, and a cancelled (or timed-out) winner with nothing else
 * succeeding is no pass either.
 */
export function verdict(jobs, label) {
  const result = {};
  for (const name of judgedNames(jobs, label)) {
    const lanes = jobs.filter((j) => j.name === name && !skipped(j));
    const conclusion = (j) => (j.status === 'completed' ? j.conclusion : null);
    const hostedOk = lanes
      .filter((j) => laneOf(j, label) === HOSTED)
      .every((j) => PASSING.has(conclusion(j)));
    result[name] = lanes.some((j) => conclusion(j) === 'success') && hostedOk;
  }
  return result;
}

async function listJobs(env) {
  const {
    GITHUB_API_URL: api,
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
  } = env;
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${api}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${env.INPUT_TOKEN}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`jobs API: HTTP ${response.status}`);
    const body = await response.json();
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) return jobs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** listJobs, retried: a transient API error must not decide a race. */
async function readJobs(env) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await listJobs(env);
    } catch (error) {
      if (attempt >= 5) throw error;
      console.log(`::warning::${error.message}; retrying`);
      await sleep(5_000 * attempt);
    }
  }
}

function output(env, name, value) {
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

const seconds = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback) * 1000;

async function start(env, label, intervalMs) {
  const delayMs = seconds(env.INPUT_DELAY, 180);
  const since = Date.now();
  for (;;) {
    let jobs;
    try {
      jobs = await readJobs(env);
    } catch (error) {
      // Unanswerable: queue the twins, which run unless their Seldon lane started first.
      console.log(`::warning::${error.message}; racing`);
      return output(env, 'race', 'true');
    }
    const decision = startDecision({
      jobs,
      label,
      now: Date.now(),
      since,
      delayMs,
      names: parseNames(env.INPUT_NAMES),
    });
    if (decision !== 'wait') return output(env, 'race', String(decision === 'race'));
    await sleep(intervalMs);
  }
}

async function finish(env, label, intervalMs) {
  const deadline = Date.now() + seconds(env.INPUT_DEADLINE, 3600);
  const names = parseNames(env.INPUT_NAMES);
  const plan = (jobs) =>
    finishPlan({ jobs, label, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, names });
  for (;;) {
    const { reap, undecided } = plan(await readJobs(env));
    if (undecided.length === 0) return output(env, 'reap', JSON.stringify(reap));
    if (Date.now() > deadline) {
      console.log(
        `::warning::No lane started for ${undecided.join(', ')}; both lanes of those stay.`,
      );
      return output(env, 'reap', JSON.stringify(reap));
    }
    await sleep(intervalMs);
  }
}

async function guard(env, label, intervalMs) {
  try {
    let me;
    // The jobs API can lag the runner by a few seconds.
    for (let tries = 0; !me && tries < 6; tries++) {
      if (tries) await sleep(5_000);
      me = (await readJobs(env)).find(
        (j) => j.runner_name === env.RUNNER_NAME && j.status === 'in_progress',
      );
    }
    if (!me) return console.log('::warning::Could not find this job in the run; running it.');
    for (let first = true; ; first = false) {
      if (!yields({ jobs: await readJobs(env), label, jobId: me.id })) {
        if (!first) console.log('The twin is gone; running.');
        return;
      }
      if (first) console.log(`${me.name}: the twin started first; waiting to be cancelled.`);
      await sleep(intervalMs);
    }
  } catch (error) {
    // A guard that cannot tell runs the lane: at worst both lanes work and finish cancels one.
    console.log(`::warning::${error.message}; running.`);
  }
}

async function judge(env, label) {
  const passed = verdict(await readJobs(env), label);
  for (const [name, ok] of Object.entries(passed)) {
    console.log(
      ok ? `${name}: passed` : `::error::${name}: no lane passed, or a hosted lane failed`,
    );
  }
  output(env, 'outcome', Object.values(passed).every(Boolean) ? 'success' : 'failure');
}

export async function main(env) {
  const label = env.INPUT_LABEL || 'seldon-ci';
  const intervalMs = seconds(env.INPUT_INTERVAL, 15);
  switch (env.INPUT_MODE) {
    case 'start':
      return start(env, label, intervalMs);
    case 'finish':
      return finish(env, label, intervalMs);
    case 'guard':
      return guard(env, label, intervalMs);
    case 'verdict':
      return judge(env, label);
    default:
      throw new Error(`mode must be start, guard, finish or verdict, not ${env.INPUT_MODE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.env).catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
