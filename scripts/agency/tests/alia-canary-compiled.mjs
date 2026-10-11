/** Actual compiled Node modules on the parent's newly created isolated DB only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'packages/api/package.json'));
const api = join(root, 'packages/api/dist');
const db = require(join(api, 'config/postgres.js'));
const schema = require(join(api, 'db/schema/index.js'));
const orm = require('drizzle-orm');
const service = require(join(api, 'services/aliaRevocationCanary.service.js'));
const material = require(join(api, 'utils/credentialMaterial.js'));
const { I03_CANARY_APPLICATION_ID, I03_CANARY_SCOPES } = require(
  join(api, 'services/applicationCredentialRevocation.service.js'),
);
const actor = {
  operatorArn: 'arn:aws:sts::237343248947:assumed-role/Fixture/compiled-node',
  authorizationSha256: 'a'.repeat(64),
};
const ownUrl = new URL(process.env.DATABASE_URL ?? '');
assert.equal(ownUrl.hostname, '127.0.0.1');
assert.equal(ownUrl.port, '5614');
assert(ownUrl.pathname.startsWith('/oxy_rehearsal_1519_'));
try {
  await db.connectPostgres();
  const sql = db.getDb();
  await sql.insert(schema.users).values({ id: service.I03_CANARY_OWNER_ID, color: 'blue' });
  const [principal] = await sql.insert(schema.users).values({ color: 'teal' }).returning();
  await sql.insert(schema.applications).values({
    id: I03_CANARY_APPLICATION_ID,
    name: 'compiled canary fixture',
    ownerAccountId: service.I03_CANARY_OWNER_ID,
    type: 'first_party',
    status: 'active',
    scopes: [...I03_CANARY_SCOPES],
  });
  await sql.insert(schema.appGrants).values({
    userId: principal.id,
    applicationId: I03_CANARY_APPLICATION_ID,
    scopes: [...I03_CANARY_SCOPES],
  });
  const plan = await service.prepareAliaRevocationCanary(principal.id, actor);
  const key = material.generateCredentialMaterial();
  await service.issueAliaRevocationCanary(plan, material.credentialVerifier(key), actor);
  key.secret = '';
  assert.equal((await service.retireAliaCanaryAfterTaskFailure(plan, actor)).retired, true);
  assert.equal((await service.retireAliaCanaryAfterTaskFailure(plan, actor)).retired, true);
  assert.equal(await service.verifyAliaCanaryAuthorityUnchanged(plan, actor), true);
  const events = await sql
    .select()
    .from(schema.applicationCredentialAuditEvents)
    .where(orm.eq(schema.applicationCredentialAuditEvents.credentialId, plan.credentialId));
  assert.deepEqual(events.map((e) => e.eventType).sort(), ['created', 'revoked']);
  assert(events.every((e) => e.actorUserId === null));
  console.log(
    JSON.stringify({
      kind: 'compiled-node-canary',
      node: process.version,
      checks: 5,
      minimalEnvironment: true,
      ownLocalDatabase: true,
      rawSecretNotPersisted: true,
      providerRequests: 0,
    }),
  );
} finally {
  await db.closePostgres();
}
