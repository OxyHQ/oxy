/**
 * The holder census (ADR 0024), against a REAL Postgres: every migration class is
 * counted where it belongs, and nothing but counts leaves the report.
 */

import { eq } from 'drizzle-orm';
import { deriveIdentityFromPrivateKey, generateWebIdentity, markWrapVerified, sealWebIdentity } from '@oxy.so/core';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { identityWebEnvelopes } from '../../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { envelopeColumns } from '../../utils/identityEnvelopeColumns';
import { reportIdentityHolderClasses } from '../report-identity-holder-classes';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('counts each class once, and reports nothing but numbers', async () => {
  const before = await reportIdentityHolderClasses();

  // Keyless with a passkey; keyless with nothing.
  const [keyless] = await getDb().insert(users).values({}).returning({ id: users.id });
  await getDb().insert(userAuthMethods).values({ userId: keyless.id, type: 'webauthn', methodCredentialId: `census-${keyless.id}` });
  await getDb().insert(users).values({});

  // A root kept only elsewhere.
  await getDb().insert(users).values({ publicKey: generateWebIdentity().publicKey });

  // A v2 mnemonic web holder with a verified wrap and a saved phrase.
  const mnemonic = generateWebIdentity();
  const [withHolder] = await getDb().insert(users).values({ publicKey: mnemonic.publicKey }).returning({ id: users.id });
  const sealedMnemonic = sealWebIdentity(mnemonic, { prfOutput: new Uint8Array(32).fill(1), credentialId: 'census-aaaaaaaaaaaaaaaaaa' }, new Date(), { version: 2 });
  sealedMnemonic.dataKey.fill(0);
  await getDb().insert(identityWebEnvelopes).values({
    userId: withHolder.id,
    ...envelopeColumns(markWrapVerified(sealedMnemonic.envelope, 'census-aaaaaaaaaaaaaaaaaa'), mnemonic.publicKey),
    phraseConfirmedAt: new Date(),
  });

  // A v2 raw-key holder whose root was since rotated away (stale).
  const raw = deriveIdentityFromPrivateKey('4d'.repeat(32));
  await getDb().delete(users).where(eq(users.publicKey, raw.publicKey));
  const [stale] = await getDb().insert(users).values({ publicKey: generateWebIdentity().publicKey }).returning({ id: users.id });
  const sealedRaw = sealWebIdentity(raw, { prfOutput: new Uint8Array(32).fill(2), credentialId: 'census-bbbbbbbbbbbbbbbbbb' }, new Date(), { version: 2 });
  sealedRaw.dataKey.fill(0);
  await getDb().insert(identityWebEnvelopes).values({ userId: stale.id, ...envelopeColumns(sealedRaw.envelope, raw.publicKey) });

  // A managed account.
  await getDb().insert(users).values({ kind: 'organization' });

  const after = await reportIdentityHolderClasses();
  const delta = (pick: (census: typeof after) => number) => pick(after) - pick(before);

  expect(delta((c) => c.accounts.personal)).toBe(5);
  expect(delta((c) => c.accounts.managed)).toBe(1);
  expect(delta((c) => c.roots.keylessWithPasskey)).toBe(1);
  expect(delta((c) => c.roots.keylessWithoutMethod)).toBe(1);
  expect(delta((c) => c.roots.linked)).toBe(3);
  expect(delta((c) => c.webHolders.total)).toBe(2);
  expect(delta((c) => c.webHolders.envelopeV2Mnemonic)).toBe(1);
  expect(delta((c) => c.webHolders.envelopeV2RawKey)).toBe(1);
  expect(delta((c) => c.webHolders.staleRoot)).toBe(1);
  expect(delta((c) => c.webHolders.withVerifiedWrap)).toBe(1);
  expect(delta((c) => c.webHolders.phraseConfirmed)).toBe(1);
  // The Commons-only root and the stale one both have no CURRENT web holder.
  expect(delta((c) => c.rootsWithoutWebHolder)).toBe(2);

  const leaves = (value: unknown): unknown[] => (value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]);
  expect(leaves(after).every((value) => typeof value === 'number')).toBe(true);
});
