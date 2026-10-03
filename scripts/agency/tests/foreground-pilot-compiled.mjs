/** Real compiled Node executor, SQL fixture only on the coordinator's new owned DB. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

assert.match(process.env.DATABASE_URL ?? '', /^postgresql:\/\/oxy@127\.0\.0\.1:5600\/oxy_rehearsal_1519_[a-f0-9]{16}$/);
assert.equal(process.env.NODE_ENV, 'production');
assert.equal(process.env.OXY_API_URL, 'https://api.oxy.so');
assert.deepEqual(Object.keys(process.env).sort(), ['DATABASE_URL', 'NODE_ENV', 'OXY_API_URL']);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'packages/api/package.json'));
const { eq, sql } = require('drizzle-orm');
const load = relative => require(path.join(root, 'packages/api/dist', relative));
const { connectPostgres, closePostgres, getDb } = load('config/postgres.js');
const { users } = load('db/schema/users.js');
const { applications } = load('db/schema/applications.js');
const { applicationWorkloadIdentities } = load('db/schema/applicationWorkloadIdentities.js');
const { applicationCredentials } = load('db/schema/applicationCredentials.js');
const { bindWorkloadIdentity } = load('services/workloadIdentityBinding.service.js');
const config = load('scripts/foregroundPilotConfiguration.js');
const { MENTION_APPLICATION_ID, OXY_PROFILE_REGISTRAR_APPLICATION_ID } = load('scripts/seedOxyApplicationsSpecs.js');
const executable = path.join(root, 'packages/api/dist/scripts/foregroundPilotExecutor.js');
let plan;
try {
  await connectPostgres();
  const db = getDb();
  const [owner] = await db.insert(users).values({ username: 'oxy', kind: 'organization' }).returning();
  const scopes = ['user:read', 'catalogs:write', 'capabilities:read', 'capability-audit:write'];
  await db.insert(applications).values({ id: MENTION_APPLICATION_ID, name: 'Synthetic Node Mention', ownerAccountId: owner.id,
    type: 'first_party', status: 'active', isOfficial: true, isInternal: false, scopes, capabilities: ['catalog:mention'] });
  for (const subject of [config.MENTION_BACKEND_ROLE, config.MENTION_MCP_ROLE]) {
    await bindWorkloadIdentity({ applicationId: MENTION_APPLICATION_ID, provider: 'aws-iam', subject, scopes,
      actor: { isPlatformStaff: true, describedAs: 'synthetic owned Node fixture' } });
  }
  const app = await db.select({ id: applications.id, type: applications.type, status: applications.status,
    is_official: applications.isOfficial, is_internal: applications.isInternal, owner_account_id: applications.ownerAccountId,
    scopes: applications.scopes, capabilities: applications.capabilities, row_revision: sql`xmin::text` })
    .from(applications).where(eq(applications.id, MENTION_APPLICATION_ID));
  const bindings = await db.select({ id: applicationWorkloadIdentities.id, application_id: applicationWorkloadIdentities.applicationId,
    provider: applicationWorkloadIdentities.provider, subject: applicationWorkloadIdentities.subject, scopes: applicationWorkloadIdentities.scopes,
    expires_at: applicationWorkloadIdentities.expiresAt, row_revision: sql`xmin::text` }).from(applicationWorkloadIdentities);
  const credentials = await db.select({ id: applicationCredentials.id, application_id: applicationCredentials.applicationId,
    type: applicationCredentials.type, environment: applicationCredentials.environment, status: applicationCredentials.status,
    expires_at: applicationCredentials.expiresAt, scopes: applicationCredentials.scopes,
    workload_identity_id: applicationCredentials.workloadIdentityId, row_revision: sql`xmin::text` }).from(applicationCredentials);
  const owners = await db.select({ id: users.id, account_status: users.accountStatus, row_revision: sql`xmin::text` }).from(users).where(eq(users.id, owner.id));
  const roots = await db.select({ id: users.id, account_status: users.accountStatus, kind: users.kind,
    is_platform_root: sql`COALESCE(${users.username} = 'oxy', false)`, row_revision: sql`xmin::text` }).from(users).where(eq(users.id, owner.id));
  const table = rows => ({ status: 'complete', count: rows.length, rows });
  const meta = { schemaVersion: 1, profile: 'oxy', readOnly: true, isolation: 'repeatable read', observedAt: new Date().toISOString(),
    runtime: { node: process.version, postgresVersion: 'synthetic-local-node-carrier', postgresEntrySha256: '0'.repeat(64) } };
  plan = config.prepareForegroundPilotPlan({ ...meta, kind: 'mention-foreground-preflight', selectedMentionApplicationId: MENTION_APPLICATION_ID,
    tables: { applications: table(app), application_workload_identities: table(bindings), application_credentials: table(credentials),
      users: table(owners), account_closure_fences: table([]), app_capability_catalog_registrations: table([]) } },
  { ...meta, kind: 'oxy-profile-registrar-preflight', proposedRegistrarApplicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
    tables: { applications: table([]), application_workload_identities: table([]), application_credentials: table([]),
      users: table(roots), account_closure_fences: table([]), app_capability_catalog_registrations: table([]) } });
  await config.applyForegroundPilotConfiguration(plan);
  const credential = await config.createEphemeralRegistrarCredential(plan);
  const run = (operation, input) => spawnSync(process.execPath, [executable, operation, Buffer.from(JSON.stringify(input)).toString('base64url')], {
    env: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'production', OXY_API_URL: 'https://api.oxy.so' }, encoding: 'utf8', timeout: 30_000,
  });
  const retired = run('retire', plan);
  assert.equal(retired.status, 0, 'compiled Node retire failed'); assert.equal(retired.stderr, '');
  assert.ok(retired.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row =>
    row.kind === 'i05-foreground-operation' && row.nonce === plan.nonce && row.operation === 'retire' && row.status === 'confirmed'));
  assert.ok(!retired.stdout.includes(credential.secret));
  assert.equal((await db.select({ status: applicationCredentials.status }).from(applicationCredentials).where(eq(applicationCredentials.id, credential.id)))[0].status, 'revoked');
  const expired = run('execute', { ...plan, expiresAt: new Date(Date.now() - 1).toISOString() });
  assert.equal(expired.status, 1); assert.equal(expired.stderr.trim(), 'I05_FOREGROUND_OPERATION_FAILED_RECONCILE_REQUIRED');
  assert.ok(!expired.stdout.includes('configuration-intent'));
  const rollback = run('rollback', plan); assert.equal(rollback.status, 0, 'compiled Node rollback failed');
  assert.equal((await db.select({ scopes: applications.scopes }).from(applications).where(eq(applications.id, MENTION_APPLICATION_ID)))[0].scopes.join(','), scopes.join(','));
  assert.equal((await db.select({ status: applications.status }).from(applications).where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID)))[0].status, 'suspended');
  console.log(JSON.stringify({ kind: 'i05-compiled-owned-fixture', checks: 3, runtime: process.version,
    environmentKeys: Object.keys(process.env).sort(), compiledCliRetire: true, compiledCliRollback: true,
    expiredExecuteBeforeEffect: true, externalHttpRequests: 0, secretInOutput: false }));
} finally {
  if (plan) await config.retireEphemeralRegistrarCredentials(plan);
  await closePostgres();
}
