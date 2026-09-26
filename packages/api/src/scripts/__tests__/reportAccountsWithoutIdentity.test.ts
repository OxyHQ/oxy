/**
 * The identity-gap report, against a REAL Postgres.
 *
 * What matters is that it counts the right accounts: an account is "without an
 * identity" only when it has no public key, only local personal accounts
 * count, and `noSignIn` (no key, no email) is the bucket with no way in.
 */

import crypto from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { reportAccountsWithoutIdentity } from '../report-accounts-without-identity';

function hexKey(): string {
  return `04${crypto.randomBytes(64).toString('hex')}`;
}

async function account(input: {
  publicKey?: string;
  email?: string;
  identityMethod?: boolean;
  type?: 'local' | 'federated';
}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      ...(input.publicKey ? { publicKey: input.publicKey } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.type ? { type: input.type } : {}),
    })
    .returning({ id: users.id });
  if (input.identityMethod) {
    await getDb().insert(userAuthMethods).values({ userId: row.id, type: 'identity', methodPublicKey: hexKey() });
  }
  return row.id;
}

function uniqueEmail(): string {
  return `gap-${crypto.randomUUID()}@example.com`;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('counts only key-less local personal accounts, split by how they sign in', async () => {
  const before = await reportAccountsWithoutIdentity();

  const withKey = await account({ publicKey: hexKey(), identityMethod: true });
  const emailOnly = await account({ email: uniqueEmail() });
  const noSignIn = await account({});
  const linkedKeyMissing = await account({ email: uniqueEmail(), identityMethod: true });
  const federated = await account({ type: 'federated' });

  // Newest first, so the accounts this test just created lead each bucket even
  // in a database another suite has already filled.
  const after = await reportAccountsWithoutIdentity(10);

  expect(after.totalUsers - before.totalUsers).toBe(4);
  expect(after.withIdentity - before.withIdentity).toBe(1);
  expect(after.withoutIdentity - before.withoutIdentity).toBe(3);
  expect(after.emailOnly - before.emailOnly).toBe(1);
  expect(after.noSignIn - before.noSignIn).toBe(1);
  expect(after.linkedKeyMissing - before.linkedKeyMissing).toBe(1);

  expect(after.samples.emailOnly).toContain(emailOnly);
  expect(after.samples.noSignIn).toContain(noSignIn);
  expect(after.samples.linkedKeyMissing).toContain(linkedKeyMissing);
  const sampled = [...after.samples.emailOnly, ...after.samples.noSignIn, ...after.samples.linkedKeyMissing];
  expect(sampled).not.toContain(withKey);
  expect(sampled).not.toContain(federated);
});

it('samples the newest accounts of each bucket', async () => {
  const older = await account({});
  const newer = await account({});
  const sample = (await reportAccountsWithoutIdentity(1)).samples.noSignIn;
  expect(sample).toEqual([newer]);
  expect(sample).not.toContain(older);
});

it('prints no ids unless asked', async () => {
  await account({});
  const report = await reportAccountsWithoutIdentity();
  expect(report.samples).toEqual({ emailOnly: [], noSignIn: [], linkedKeyMissing: [] });
});
