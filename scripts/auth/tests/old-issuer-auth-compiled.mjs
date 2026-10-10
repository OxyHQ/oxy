/** Actual emitted Node entrypoint and CAS on a newly owned local database. Synthetic quiescence only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.deepEqual(Object.keys(process.env).sort(), ['DATABASE_URL', 'NODE_ENV', 'OXY_API_URL']);
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5601');
assert.match(url.pathname, /^\/oxy_rehearsal_1519_[a-f0-9]{16}$/);
assert.equal(process.env.NODE_ENV, 'production');
assert.equal(process.env.OXY_API_URL, 'https://api.oxy.so');
const require = createRequire(resolve(root, 'packages/api/package.json'));
const { sql } = require('drizzle-orm');
const { users } = require(resolve(root, 'packages/api/dist/db/schema/users.js'));
const { getDb, connectPostgres, closePostgres } = require(
  resolve(root, 'packages/api/dist/config/postgres.js'),
);
const { prepareOldIssuerAuthRetirement, retireOldIssuerAuth } = require(
  resolve(root, 'packages/api/dist/scripts/oldIssuerAuthRetirement.js'),
);
const { default: sessionService } = require(
  resolve(root, 'packages/api/dist/services/session.service.js'),
);
const scratch = await mkdtemp(resolve(tmpdir(), 'old-issuer-auth-node-'));
const bot = randomUUID();
const human = randomUUID();
const key = randomUUID();
const agentSession = randomUUID();
const ordinarySession = randomUUID();
const input = {
  maintenancePlanSha256: 'a'.repeat(64),
  admissionPaths: ['/fixture-external', '/fixture-internal'],
  affectedServices: [
    {
      name: 'fixture-issuer',
      taskDefinition: 'fixture:692',
      targetGroups: [],
      capturedTasks: ['fixture-task'],
      hasScaling: false,
    },
  ],
};
try {
  await connectPostgres();
  await getDb()
    .insert(users)
    .values([
      { id: bot, username: `compiledbot${randomUUID().replaceAll('-', '')}`, kind: 'bot' },
      { id: human, username: `compiledhuman${randomUUID().replaceAll('-', '')}`, kind: 'personal' },
    ]);
  await getDb().execute(sql`insert into user_auth_methods(id,user_id,type,method_public_key,label,enrollment_method)
    values (${key},${bot},'agent_key',${randomUUID()},'compiled fixture','governor')`);
  await getDb().execute(sql`insert into sessions(id,session_id,user_id,device_id,device_type,platform,access_token,refresh_token,expires_at,auth_method_id,auth_method_owner_id)
    values (${randomUUID()},${agentSession},${bot},${randomUUID()},'web','web','compiled synthetic token','compiled synthetic refresh',now()+interval '1 hour',${key},${bot}),
    (${randomUUID()},${ordinarySession},${human},${randomUUID()},'web','web','ordinary synthetic token','ordinary synthetic refresh',now()+interval '1 hour',null,null)`);
  const before = await getDb().execute(
    sql`select is_active from sessions where session_id=${agentSession}`,
  );
  const inputPath = resolve(scratch, 'input.json');
  await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'packages/api/dist/scripts/oldIssuerAuthRetirement.js'), 'prepare', inputPath],
    {
      cwd: resolve(root, 'packages/api'),
      env: process.env,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 512 * 1024,
    },
  );
  assert.equal(result.status, 0, 'compiled prepare exited successfully');
  const plans = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row?.kind === 'old-issuer-auth-retirement');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].productionReady, false);
  assert.equal(plans[0].snapshot.sessions.length, 1);
  assert.ok(!result.stdout.includes('compiled synthetic token'));
  assert.deepEqual(
    await getDb().execute(sql`select is_active from sessions where session_id=${agentSession}`),
    before,
  );
  const plan = await prepareOldIssuerAuthRetirement(input);
  assert.ok(await sessionService.getSession(agentSession));
  const phases = [];
  await retireOldIssuerAuth(
    plan,
    async () => ({
      kind: 'old-issuer-quiescence-readback',
      observedAt: new Date().toISOString(),
      maintenancePlanSha256: input.maintenancePlanSha256,
      standaloneWriters: [],
      admissionProbes: input.admissionPaths.map((path) => ({ path, status: 503 })),
      services: [
        {
          name: 'fixture-issuer',
          taskDefinition: 'fixture:692',
          desiredCount: 0,
          runningCount: 0,
          pendingCount: 0,
          capturedTasks: ['fixture-task'],
          stoppedTasks: ['fixture-task'],
          targetGroups: [],
          drainedTargetGroups: [],
          scaling: null,
        },
      ],
    }),
    async (event) => {
      phases.push(event.phase);
    },
  );
  assert.equal(await sessionService.getSession(agentSession), null);
  assert.ok(await sessionService.getSession(ordinarySession, false));
  assert.equal(phases.at(-1), 'auth-retirement-confirmed-maintenance-required');
  console.log(
    JSON.stringify({
      compiledNode: process.version,
      environmentKeys: Object.keys(process.env).sort(),
      signingKeys: false,
      redisConfigured: false,
      liveQuiescence: false,
      providerRequests: 0,
      readOnlyCliChecks: 1,
      canonicalExecutorChecks: 1,
      productionReady: false,
    }),
  );
} finally {
  await closePostgres();
  await rm(scratch, { recursive: true, force: true });
}
