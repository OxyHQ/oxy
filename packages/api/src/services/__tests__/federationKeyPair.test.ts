/**
 * Federation key pairs against a REAL Postgres.
 *
 * The suite this replaces mocked `mongoose` wholesale — `model()` returned a
 * `{ findOne, create }` pair of `jest.fn`s — and asserted that `findOne` was
 * CALLED with the lowercased keyId. That proved the argument was built as
 * expected and nothing else: it could not have caught a key stored under one
 * id and read back under another, because no row ever existed.
 *
 * Every assertion here reads the row back.
 *
 * MOCKED, because each is a collaborator this file is not about: the asset and
 * S3 services (federated avatar storage) and `userCache`.
 */

import { createVerify } from 'node:crypto';
import { eq } from 'drizzle-orm';

jest.mock('../assetService', () => ({
  __esModule: true,
  AssetService: class {},
}));

jest.mock('../s3Service', () => ({
  createS3Service: jest.fn(),
}));

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { federationKeyPairs } from '../../db/schema/federationKeyPairs';
import { getPublicKeyForKeyId, getUserKeyPair, signWithKeyId } from '../federation.service';

const DOMAIN = 'mention.earth';

/** The row stored for `keyId`, including the private half. */
async function storedKeyPair(keyId: string) {
  const [row] = await getDb()
    .select({
      keyId: federationKeyPairs.keyId,
      publicKeyPem: federationKeyPairs.publicKeyPem,
      privateKeyPem: federationKeyPairs.privateKeyPem,
    })
    .from(federationKeyPairs)
    .where(eq(federationKeyPairs.keyId, keyId))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getUserKeyPair', () => {
  it('lowercases a mixed-case username into the stored keyId', async () => {
    const keyPair = await getUserKeyPair('Bob', DOMAIN);

    const expectedKeyId = `https://${DOMAIN}/ap/users/bob#main-key`;
    expect(keyPair.keyId).toBe(expectedKeyId);

    // The row itself, not just the returned value — a keyId normalized on the
    // way out but stored raw would still answer this call correctly and then
    // miss on every subsequent lookup.
    const stored = await storedKeyPair(expectedKeyId);
    expect(stored).not.toBeNull();
    expect(stored?.publicKeyPem).toBe(keyPair.publicKeyPem);
  });

  it('returns the SAME key pair for every casing of one username', async () => {
    const lower = await getUserKeyPair('carol', DOMAIN);
    const upper = await getUserKeyPair('CAROL', DOMAIN);
    const mixed = await getUserKeyPair('  CaRoL  ', DOMAIN);

    expect(upper.publicKeyPem).toBe(lower.publicKeyPem);
    expect(mixed.publicKeyPem).toBe(lower.publicKeyPem);

    // Exactly one row exists — a second key for the same actor would mean a
    // signature made with one and verified against the other, which fails
    // remotely and looks like a federation outage rather than a bug here.
    const rows = await getDb()
      .select({ id: federationKeyPairs.id })
      .from(federationKeyPairs)
      .where(eq(federationKeyPairs.keyId, `https://${DOMAIN}/ap/users/carol#main-key`));
    expect(rows).toHaveLength(1);
  });

  it('scopes a key pair per domain, so one username maps to distinct keys', async () => {
    const here = await getUserKeyPair('dave', 'a.example');
    const there = await getUserKeyPair('dave', 'b.example');

    expect(here.keyId).toBe('https://a.example/ap/users/dave#main-key');
    expect(there.keyId).toBe('https://b.example/ap/users/dave#main-key');
    expect(here.publicKeyPem).not.toBe(there.publicKeyPem);
  });

  it('stores a usable RSA pair — the private half signs, the public half verifies', async () => {
    const keyPair = await getUserKeyPair('erin', DOMAIN);

    const signature = await signWithKeyId(keyPair.keyId, 'signing string');
    expect(signature).not.toBeNull();

    const verifier = createVerify('sha256');
    verifier.update('signing string');
    verifier.end();
    expect(signature).not.toBeNull();
    expect(verifier.verify(keyPair.publicKeyPem, signature ?? '', 'base64')).toBe(true);
  });
});

describe('getPublicKeyForKeyId', () => {
  it('never returns the private half', async () => {
    const keyPair = await getUserKeyPair('frank', DOMAIN);

    const published = await getPublicKeyForKeyId(keyPair.keyId);

    expect(published).toEqual({
      keyId: keyPair.keyId,
      publicKeyPem: keyPair.publicKeyPem,
    });
    // The exact-equality above already pins the shape; this states the
    // guarantee the endpoint exists to keep.
    expect(Object.keys(published ?? {})).not.toContain('privateKeyPem');
  });

  it('returns null for an unknown keyId rather than minting one', async () => {
    const keyId = `https://${DOMAIN}/ap/users/never-created#main-key`;

    expect(await getPublicKeyForKeyId(keyId)).toBeNull();
    expect(await storedKeyPair(keyId)).toBeNull();
  });
});

describe('signWithKeyId', () => {
  it('returns null for an unknown keyId — it never auto-creates a key', async () => {
    const keyId = `https://${DOMAIN}/ap/users/unknown-signer#main-key`;

    expect(await signWithKeyId(keyId, 'anything')).toBeNull();
    expect(await storedKeyPair(keyId)).toBeNull();
  });
});
