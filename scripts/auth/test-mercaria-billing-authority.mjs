/** Local integration: actual Node eval command + compiled CAS + owned PostgreSQL.
 * No network authority, AWS identity, HTTP, or production database is used.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const api = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/api');
const require = createRequire(resolve(api, 'package.json'));
const url = new URL(process.env.AUTHORITY_TEST_ADMIN_URL ?? 'invalid:');
assert.equal(url.protocol, 'postgres:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/postgres');
process.env.TEST_DATABASE_URL = url.href;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const postgres = require('postgres');
const { createTestDatabase, dropTestDatabase } = require(resolve(api, 'dist/db/testDatabase.js'));
const source = readFileSync(new URL('./mercaria-billing-authority.mjs', import.meta.url), 'utf8');
const { connectPostgres, closePostgres, getDb } = require(resolve(api, 'dist/config/postgres.js'));
const { users } = require(resolve(api, 'dist/db/schema/users.js'));
const { applications } = require(resolve(api, 'dist/db/schema/applications.js'));
const { applicationCredentials } = require(resolve(api, 'dist/db/schema/applicationCredentials.js'));
const { accountClosureFences } = require(resolve(api, 'dist/db/schema/accountClosureFences.js'));
const { MERCARIA_BILLING_BASE_SCOPES: BASE, MERCARIA_BILLING_SCOPES: NEXT } = require(resolve(api, 'dist/services/mercariaBillingAuthority.service.js'));
const { eq, sql } = require('drizzle-orm');
const target = { applicationId: '6a37d0cc5d4b5f15482a9340', credentialId: '01a061cd-39a9-7bd6-ba31-70ef7590c953', ownerAccountId: '69b2d3df5d12f58c9800d651' };
const operator = { account: '237343248947', arn: 'arn:aws:iam::237343248947:user/synthetic-local-fixture', receiptSha256: 'a'.repeat(64) };
let databaseUrl;
let original;
function invoke(mode, input, changes = {}, badHash = false) {
  const request = { schemaVersion: 1, nonce: 'b'.repeat(32), operator, mode, ...(input ? { input } : {}), ...changes };
  const bytes = JSON.stringify(request);
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source, '--', '--execute', bytes, badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')], {
    cwd: api, timeout: 20000, encoding: 'utf8',
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  });
}
function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('OXY_BILLING_AUTHORITY_RESULT '));
  const value = JSON.parse(lines[0].slice('OXY_BILLING_AUTHORITY_RESULT '.length));
  assert.equal(value.operatorReceiptSha256, operator.receiptSha256);
  assert.equal(value.nonce, 'b'.repeat(32));
  return value.result;
}
function failure(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'OXY_BILLING_AUTHORITY_FAILED: reconcile exact target and attempt; no automatic retry\n');
}
async function rows() {
  const app = await getDb().select().from(applications).where(eq(applications.id, target.applicationId));
  const credentials = await getDb().select().from(applicationCredentials).where(eq(applicationCredentials.applicationId, target.applicationId));
  return { app: app[0], credentials };
}
before(async () => {
  databaseUrl = await createTestDatabase();
  await connectPostgres();
  await getDb().insert(users).values({ id: target.ownerAccountId, color: 'teal' });
  await getDb().insert(applications).values({ id: target.applicationId, ownerAccountId: target.ownerAccountId, name: 'Synthetic local Mercaria authority fixture', type: 'first_party', status: 'active', scopes: [...BASE] });
  await getDb().insert(applicationCredentials).values([
    { id: target.credentialId, applicationId: target.applicationId, type: 'service', environment: 'production', status: 'active', name: 'synthetic service fixture', publicKey: 'synthetic-cas-only', secretHash: 'c'.repeat(64), scopes: [...BASE] },
    { applicationId: target.applicationId, type: 'public', environment: 'production', status: 'active', name: 'synthetic public fixture', publicKey: 'synthetic-untouched', scopes: ['user:read'] },
  ]);
  original = await rows();
});
after(async () => {
  await closePostgres();
  if (databaseUrl) {
    await dropTestDatabase(databaseUrl);
    const admin = postgres(url.href, { max: 1 });
    try { assert.equal((await admin`select datname from pg_database where datname = ${new URL(databaseUrl).pathname.slice(1)}`).length, 0); }
    finally { await admin.end(); }
    console.log('OWNED_DATABASE_DROPPED');
  }
});
test('compiled runner prepare/apply/rollback preserves unrelated rows and rejects replay', async () => {
  const plan = success(invoke('prepare'));
  assert.deepEqual(await rows(), original);
  const receipt = success(invoke('apply', plan));
  assert.equal(receipt.actor, operator.arn);
  assert.deepEqual(receipt.after.application.scopes, NEXT);
  assert.deepEqual(receipt.after.credential.scopes, NEXT);
  const current = await rows();
  assert.deepEqual({ ...current.app, scopes: original.app.scopes, updatedAt: original.app.updatedAt }, original.app);
  assert.deepEqual(current.credentials.find(x => x.type === 'public'), original.credentials.find(x => x.type === 'public'));
  failure(invoke('apply', plan));
  assert.deepEqual(await rows(), current);
  const restored = success(invoke('rollback', receipt));
  assert.deepEqual(restored.after.application.scopes, BASE);
  assert.deepEqual(restored.after.credential.scopes, BASE);
  failure(invoke('rollback', receipt));
});
test('foreign target, extra payload and hash mismatch refuse without any row mutation', async () => {
  const plan = success(invoke('prepare')); const beforeRows = await rows();
  failure(invoke('apply', { ...plan, target: { ...target, ownerAccountId: 'not-our-owner' } }));
  failure(invoke('prepare', undefined, { token: 'private-should-not-log' }));
  failure(invoke('prepare', undefined, {}, true));
  assert.deepEqual(await rows(), beforeRows);
});
test('CAS detects same-scopes timestamp-preserving ABA across separate Node processes', async () => {
  const plan = success(invoke('prepare'));
  await getDb().update(applications).set({ scopes: [...BASE], updatedAt: sql`${plan.before.application.updatedAt}::timestamptz` }).where(eq(applications.id, target.applicationId));
  const beforeRows = await rows();
  failure(invoke('apply', plan));
  assert.deepEqual(await rows(), beforeRows);
});
test('closure fence rejects prepare before any authority change', async () => {
  await getDb().insert(accountClosureFences).values({ accountId: target.ownerAccountId });
  const beforeRows = await rows();
  failure(invoke('prepare'));
  assert.deepEqual(await rows(), beforeRows);
});
