/** Register only an additional public client in the already-owned I11 fixture. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readlink, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../src/config/postgres';
import { applications } from '../src/db/schema/applications';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { users } from '../src/db/schema/users';

async function main() {
  const [manifestArgument, lane = 'native'] = process.argv.slice(2);
  assert(manifestArgument && (process.argv.length === 3 || process.argv.length === 4));
  assert(['native', 'nativeFirst', 'nativeSecond', 'nativeIdentity'].includes(lane));
  const trusted = lane !== 'native';
  const manifestPath = resolve(manifestArgument);
  assert(/\/\.integration-evidence\/oauth1519-[a-z0-9_-]+\/manifest\.json$/.test(manifestPath));
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(database.hostname === '127.0.0.1' && database.port === '5589');
  assert(/^\/oxy_browser_1519_[a-f0-9]{16}$/.test(database.pathname));
  assert(process.env.NODE_ENV === 'test');
  const pgData = join(dirname(manifestPath), 'data');
  const pidRows = (await readFile(join(pgData, 'postmaster.pid'), 'utf8')).split('\n');
  assert(resolve(pidRows[1]) === pgData && pidRows[3] === '5589');
  assert(Number.isInteger(Number(pidRows[0])) && Number(pidRows[0]) > 1);
  assert((await stat(`/proc/${pidRows[0]}`)).uid === process.getuid?.());
  assert((await readlink(`/proc/${pidRows[0]}/exe`)) === '/usr/lib/postgresql/17/bin/postgres');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    fixtureOnly: boolean;
    person: { id: string };
    clients: Record<
      string,
      {
        appId: string;
        clientId: string;
        origin: string;
        redirectUri?: string;
      }
    >;
  };
  assert(manifest.fixtureOnly === true && typeof manifest.person.id === 'string');
  assert(!manifest.clients[lane], 'Named fixture client already registered');
  await connectPostgres();
  const data = await getDb().execute(sql`SELECT current_setting('data_directory') AS path`);
  assert(data[0]?.path === pgData);
  const clientId = `oxy_dk_${randomBytes(24).toString('hex')}`;
  const redirectUri = 'astro://oauth/callback';
  const appId = await getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ email: users.email, kind: users.kind })
      .from(users)
      .where(eq(users.id, manifest.person.id))
      .limit(1);
    assert(owner?.kind === 'personal' && owner.email?.endsWith('@fixture.invalid'));
    const [app] = await tx
      .insert(applications)
      .values({
        name: `I11 disposable ${lane}`,
        ownerAccountId: manifest.person.id,
        createdByUserId: manifest.person.id,
        type: trusted ? 'internal' : 'third_party',
        isOfficial: trusted,
        isInternal: trusted,
        status: 'active',
        scopes: ['user:read'],
        redirectUris: [redirectUri],
      })
      .returning({ id: applications.id });
    await tx.insert(applicationCredentials).values({
      applicationId: app.id,
      name: 'I11 native fixture',
      publicKey: clientId,
      type: 'public',
      environment: 'development',
      status: 'active',
    });
    return app.id;
  });
  manifest.clients[lane] = { appId, clientId, origin: 'astro://oauth', redirectUri };
  const staged = `${manifestPath}.native.tmp`;
  await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, manifestPath);
  console.log(
    JSON.stringify({
      registered: true,
      lane,
      appId,
      clientId,
      redirectUri,
      trusted,
      fixtureOnly: true,
    }),
  );
}
void main()
  .finally(() => closePostgres())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
