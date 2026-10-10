import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import postgres from 'postgres';

const appId = '73176d04c3654667138c23ec';
const ownerId = 'goway-rollback-fixture-owner';
const credentialId = 'goway-rollback-fixture-credential';
const publicKey = 'oxy_dk_goway_rollback_fixture';
const databaseUrl = process.env.DATABASE_URL!;
if (!/^\/oxy_test_[a-f0-9]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error('Rollback fixture requires the Jest-owned database');
}
const sql = postgres(databaseUrl, { max: 1 });
const script = resolve(
  __dirname,
  '../../../../../docs/architecture/1519-consumer-rollout-preflight/goway-rollback.sql',
);

async function receipt() {
  const [app] = await sql`select xmin::text as version from applications where id=${appId}`;
  const [credential] =
    await sql`select xmin::text as version from application_credentials where id=${credentialId}`;
  return { app: app.version as string, credential: credential.version as string };
}
function rollback(version: { app: string; credential: string }) {
  return spawnSync(
    'psql',
    [
      databaseUrl,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `owner_id=${ownerId}`,
      '-v',
      `credential_id=${credentialId}`,
      '-v',
      `public_client_id=${publicKey}`,
      '-v',
      `app_xmin=${version.app}`,
      '-v',
      `credential_xmin=${version.credential}`,
      '-f',
      script,
    ],
    { encoding: 'utf8' },
  );
}
async function state() {
  const [app] = await sql`select status from applications where id=${appId}`;
  const [credential] =
    await sql`select status from application_credentials where id=${credentialId}`;
  return [app.status, credential.status];
}
beforeEach(async () => {
  await sql`delete from applications where id=${appId}`;
  await sql`insert into users (id, color) values (${ownerId}, '#123456') on conflict do nothing`;
  await sql`insert into applications (id,name,website_url,type,status,is_official,is_internal,owner_account_id,created_by_user_id,redirect_uris,scopes)
    values (${appId},'GoWay','https://goway.to','first_party','active',true,false,${ownerId},${ownerId},ARRAY['https://goway.to'],ARRAY['user:read'])`;
  await sql`insert into application_credentials (id,application_id,name,type,environment,status,public_key,created_by_user_id,scopes)
    values (${credentialId},${appId},'fixture','public','production','active',${publicKey},${ownerId},ARRAY['user:read'])`;
});
afterAll(async () => {
  await sql.end();
});

it('executes the exact SQL template atomically and retains both history rows', async () => {
  const result = rollback(await receipt());
  expect(result.status).toBe(0);
  expect(await state()).toEqual(['suspended', 'revoked']);
});
it('rejects a changed credential without suspending the application', async () => {
  const version = await receipt();
  await sql`update application_credentials set name='changed after receipt' where id=${credentialId}`;
  const result = rollback(version);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('refusing rollback');
  expect(await state()).toEqual(['active', 'active']);
});
it('rejects an application changed after the receipt without revoking the credential', async () => {
  const version = await receipt();
  await sql`update applications set description='changed after receipt' where id=${appId}`;
  const result = rollback(version);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('refusing rollback');
  expect(await state()).toEqual(['active', 'active']);
});
it('rejects additional credentials even when the original receipt versions match', async () => {
  const version = await receipt();
  await sql`insert into application_credentials (id,application_id,name,type,environment,status,public_key,created_by_user_id,scopes)
    values ('goway-rollback-fixture-extra',${appId},'extra','public','production','active','oxy_dk_extra_fixture',${ownerId},ARRAY['user:read'])`;
  const result = rollback(version);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('refusing rollback');
  expect(await state()).toEqual(['active', 'active']);
});
