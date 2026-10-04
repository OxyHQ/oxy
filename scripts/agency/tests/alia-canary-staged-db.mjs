/** Local own-Postgres proof for the operational module against extracted image dist.
 * The runner provides a fresh fully migrated database and drops it afterwards.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { stageAliaCanaryModule } from '../stage-alia-canary-module.mjs';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5598');
assert.match(url.pathname, /^\/i03_staged_[a-f0-9]{16}$/);
const apiPackage = resolve(process.argv[2]); const root = dirname(apiPackage);
const require = createRequire(apiPackage); const db = require(join(root, 'dist/config/postgres.js'));
const originalPath = join(root, 'dist/services/aliaRevocationCanary.service.js');
const originalBytes = readFileSync(originalPath);
assert.equal(createHash('sha256').update(originalBytes).digest('hex'), '363cba14df14761139aea3f21ffd7a60eb1394f386380e9de24eeee0f150e098');
const original = require(originalPath); const { sql, eq } = require('drizzle-orm');
const { users } = require(join(root, 'dist/db/schema/users.js'));
const { applications } = require(join(root, 'dist/db/schema/applications.js'));
const { appGrants } = require(join(root, 'dist/db/schema/appGrants.js'));
const { applicationCredentials } = require(join(root, 'dist/db/schema/applicationCredentials.js'));
const { generateCredentialMaterial } = require(join(root, 'dist/utils/credentialMaterial.js'));
const owner = '01a0369b-1222-712f-8df6-f8ffeb78ccc2', applicationId = '6a2f851751b784a86fd0e934';
const principalId = randomUUID(); const scopes = ['acting-as:offline', 'inference:invoke'];
const operator = { operatorArn: 'arn:aws:sts::237343248947:assumed-role/Fixture/staged-fixture', authorizationSha256: 'a'.repeat(64) };
let staged;
try {
  await db.connectPostgres();
  await db.getDb().insert(users).values([{ id: owner, color: 'blue' }, { id: principalId, color: 'teal' }]);
  await db.getDb().insert(applications).values({ id: applicationId, name: 'Synthetic local canary fixture', ownerAccountId: owner,
    type: 'internal', status: 'active', isInternal: true, isOfficial: true, scopes });
  const [grant] = await db.getDb().insert(appGrants).values({ userId: principalId, applicationId, scopes }).returning();
  await assert.rejects(original.prepareAliaRevocationCanary(principalId, operator), /precondition/);
  staged = stageAliaCanaryModule({ apiPackage, source: readFileSync(new URL('../artifacts/alia-revocation-canary.cjs', import.meta.url)) });
  const canary = require(staged.canaryModulePath);
  const plan = await canary.prepareAliaRevocationCanary(principalId, operator);
  assert.equal(plan.ownerAccountId, owner);
  const material = generateCredentialMaterial();
  await db.getDb().update(applications).set({ lastUsedAt: new Date() }).where(eq(applications.id, applicationId));
  assert.equal(await canary.verifyAliaCanaryAuthorityUnchanged(plan, operator), true);
  await canary.issueAliaRevocationCanary(plan, material, operator);
  assert.deepEqual(await canary.inspectAliaRevocationCanary(plan, material, operator), { exists: true, status: 'active' });
  await canary.revokeAliaRevocationCanary(plan, material, operator);
  assert.deepEqual(await canary.inspectAliaRevocationCanary(plan, material, operator), { exists: true, status: 'revoked' });
  assert.equal(await canary.verifyAliaCanaryAuthorityUnchanged(plan, operator), true);
  assert.deepEqual(await db.getDb().select().from(appGrants).where(eq(appGrants.id, grant.id)), [grant]);
  assert.equal((await db.getDb().select().from(applicationCredentials)).length, 1);
  const recovered = await canary.retireAliaCanaryAfterTaskFailure(plan, operator);
  assert.equal(recovered.retired, true);
  await db.getDb().update(applications).set({ ownerAccountId: principalId }).where(eq(applications.id, applicationId));
  await assert.rejects(canary.prepareAliaRevocationCanary(principalId, operator), /precondition/);
  assert.deepEqual(readFileSync(originalPath), originalBytes);
  assert.equal(original.I03_CANARY_OWNER_ID, '69b2d3df5d12f58c9800d651');
  console.log(JSON.stringify({ kind: 'staged-canary-own-db-proof', originalPrepareDenied: true, correctedPrepareIssued: true, activityChangedBeforeIssue: true,
    canonicalRevokeAndRecovery: true, grantUnchanged: true, changedOwnerDenied: true,
    originalModuleBytesAndCachedExportsUnchanged: true, database: url.pathname.slice(1), noExternalHTTP: true }));
} finally {
  try { if (staged) staged.cleanup(); } finally { await db.closePostgres(); }
}
