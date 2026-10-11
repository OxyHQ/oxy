/** Disposable full API host for I11. No auth path is mocked or replaced. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { connectPostgres, closePostgres, getDb } from '../src/config/postgres';
import { applications } from '../src/db/schema/applications';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { users } from '../src/db/schema/users';
import { accountMembers } from '../src/db/schema/accountMembers';
import { storePassword } from '../src/services/password.service';
import { refreshOriginRegistry, stopOriginRegistry } from '../src/config/dynamicOriginRegistry';

async function main(): Promise<void> {
  const [manifestPath] = process.argv.slice(2);
  assert(manifestPath && process.argv.length === 3, 'One owned manifest path required');
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(database.hostname === '127.0.0.1' && database.port === '5589');
  assert(/^\/oxy_browser_1519_[a-f0-9]{16}$/.test(database.pathname));
  assert(process.env.NODE_ENV === 'test');
  // `server.ts` calls dotenv.config() itself. Run from a new empty directory,
  // so neither Bun nor that explicit loader can inherit an application .env.
  try {
    await readFile(resolve('.env'));
    throw new Error('Fixture cwd must not contain .env');
  } catch (error) {
    assert((error as NodeJS.ErrnoException).code === 'ENOENT');
  }

  // No remote fetch is permitted. API routes and sockets stay real; this is an
  // external-I/O tripwire, not a fabricated authorization/exchange response.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(url.hostname === '127.0.0.1' || url.hostname === 'localhost', 'Unexpected remote fetch');
    return originalFetch(input, init);
  }) as typeof fetch;

  // Real loopback SMTP transport: auth generates/verifies its own code and
  // password proofs. Only external delivery ends at this owned mail sink.
  const mailDirectory = join(dirname(manifestPath), 'mail');
  await mkdir(mailDirectory, { mode: 0o700 });
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: 65_536,
    onRcptTo(address, _session, callback) {
      callback(
        address.address.toLowerCase().endsWith('@fixture.invalid')
          ? undefined
          : new Error('Only disposable fixture recipients are accepted'),
      );
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      let received = 0;
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received <= 65_536) chunks.push(chunk);
      });
      stream.once('end', () => {
        if (received > 65_536) {
          callback(new Error('Fixture SMTP message exceeds bound'));
          return;
        }
        void writeFile(
          join(mailDirectory, `${randomBytes(8).toString('hex')}.eml`),
          Buffer.concat(chunks),
          { mode: 0o600 },
        ).then(() => callback(), callback);
      });
      stream.once('error', callback);
    },
  });
  await new Promise<void>((done) => smtp.listen(17964, '127.0.0.1', done));

  await connectPostgres();
  const suffix = randomBytes(5).toString('hex');
  const password = 'Oxy1519-Disposable-Fixture-Password!';
  const [person] = await getDb()
    .insert(users)
    .values({
      username: `browser${suffix}`,
      email: `browser${suffix}@fixture.invalid`,
      kind: 'personal',
    })
    .returning({ id: users.id, username: users.username });
  const [stranger] = await getDb()
    .insert(users)
    .values({
      username: `stranger${suffix}`,
      email: `stranger${suffix}@fixture.invalid`,
      kind: 'personal',
    })
    .returning({ id: users.id, username: users.username });
  const [organization] = await getDb()
    .insert(users)
    .values({
      username: `group${suffix}`,
      kind: 'organization',
    })
    .returning({ id: users.id, username: users.username });
  await storePassword(person.id, password);
  await storePassword(stranger.id, password);
  await getDb().insert(accountMembers).values({
    accountId: organization.id,
    memberUserId: person.id,
    role: 'admin',
    status: 'active',
  });

  const origins = {
    api: 'http://127.0.0.1:17960',
    idp: 'http://127.0.0.1:17961',
    a: 'http://127.0.0.1:17962',
    b: 'http://127.0.0.1:17963',
  };
  const clients: Record<string, { appId: string; clientId: string; origin: string }> = {};
  for (const lane of ['idp', 'a', 'b'] as const) {
    const origin = origins[lane];
    const [app] = await getDb()
      .insert(applications)
      .values({
        name: `I11 disposable ${lane} ${suffix}`,
        ownerAccountId: person.id,
        createdByUserId: person.id,
        type: lane === 'idp' ? 'internal' : 'third_party',
        isOfficial: lane === 'idp',
        isInternal: lane === 'idp',
        status: 'active',
        scopes: ['user:read'],
        redirectUris: [`${origin}/`],
        websiteUrl: origin,
      })
      .returning({ id: applications.id });
    const clientId = `oxy_dk_${randomBytes(24).toString('hex')}`;
    await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: app.id,
        name: `I11 fixture ${lane}`,
        publicKey: clientId,
        type: 'public',
        environment: 'development',
        status: 'active',
      });
    clients[lane] = { appId: app.id, clientId, origin };
  }
  await refreshOriginRegistry({ required: true });

  // Import the actual API host after the real registry is seeded. Deliberately
  // do not invoke bootstrap's ecosystem seeds, workers or reconciliation loops.
  // This retains production router mounts, parsers, JWT/session middleware,
  // rate-limiters, CORS, security headers, error handlers and Socket.IO auth.
  const { default: server } = require('../src/server') as typeof import('../src/server');
  await new Promise<void>((done) => server.listen(17960, '127.0.0.1', done));
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      { origins, clients, person, stranger, organization, password, fixtureOnly: true },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ fixtureReady: true, manifestPath, port: 17960 }));

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    stopOriginRegistry();
    const { closeIO } = await import('../src/utils/socket.js');
    closeIO();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => smtp.close(done));
    await closePostgres();
    console.log(JSON.stringify({ fixtureStopped: true }));
    process.exit(0);
  }
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void closePostgres();
});
