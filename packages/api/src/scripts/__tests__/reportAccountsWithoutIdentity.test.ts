/**
 * The identity-gap report, against a REAL Postgres.
 *
 * It exists to aim the phase-2 prompt, so what matters is that it counts the
 * right accounts: an account is "without an identity" only when it has no
 * public key, and passkey-only is the bucket the sign-in prompt can reach.
 */

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { reportAccountsWithoutIdentity } from '../report-accounts-without-identity';

const KEY = `04${'a'.repeat(128)}`;

async function account(publicKey: string | null, methods: ('webauthn' | 'identity')[]): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...(publicKey ? { publicKey } : {}) })
    .returning({ id: users.id });
  let n = 0;
  for (const type of methods) {
    n += 1;
    await getDb()
      .insert(userAuthMethods)
      .values(
        type === 'webauthn'
          ? { userId: row.id, type, methodCredentialId: `${row.id}-${n}` }
          : { userId: row.id, type, methodPublicKey: `04${'b'.repeat(126)}${n}${n}` },
      );
  }
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('counts only key-less accounts, split by how they sign in', async () => {
  const before = await reportAccountsWithoutIdentity();

  const withKey = await account(KEY, ['webauthn']);
  const passkeyOnly = await account(null, ['webauthn', 'webauthn']);
  const noMethod = await account(null, []);
  const linkedKeyMissing = await account(null, ['webauthn', 'identity']);

  const after = await reportAccountsWithoutIdentity(10);

  expect(after.totalUsers - before.totalUsers).toBe(4);
  expect(after.withIdentity - before.withIdentity).toBe(1);
  expect(after.withoutIdentity - before.withoutIdentity).toBe(3);
  expect(after.passkeyOnly - before.passkeyOnly).toBe(1);
  expect(after.noAuthMethod - before.noAuthMethod).toBe(1);
  expect(after.linkedKeyMissing - before.linkedKeyMissing).toBe(1);

  expect(after.samples.passkeyOnly).toContain(passkeyOnly);
  expect(after.samples.noAuthMethod).toContain(noMethod);
  expect(after.samples.linkedKeyMissing).toContain(linkedKeyMissing);
  expect([...after.samples.passkeyOnly, ...after.samples.noAuthMethod, ...after.samples.linkedKeyMissing]).not.toContain(withKey);
});

it('prints no ids unless asked', async () => {
  await account(null, ['webauthn']);
  const report = await reportAccountsWithoutIdentity();
  expect(report.samples).toEqual({ passkeyOnly: [], noAuthMethod: [], linkedKeyMissing: [] });
});
