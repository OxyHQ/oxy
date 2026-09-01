/**
 * The signed identity export (B6, "credible exit"), against a REAL Postgres.
 *
 * ## The guarantees this file exists for
 *
 * 1. **The bundle omits every secret.** This is the whole reason the export can
 *    exist: the user downloads their account, and a leak here is permanent and
 *    self-service. Mongoose gave it for free via `select: false` plus a
 *    `.select('-password …')` string; drizzle enumerates columns explicitly, so
 *    a naive port returns the raw phone, the contact-discovery hashes and the
 *    refresh token WITHOUT NAMING ANY OF THEM (`schema/CONVENTIONS.md`,
 *    "Protected columns"). The cases below seed real secret values and assert
 *    they appear NOWHERE in the serialized bundle.
 * 2. **The attestation verifies, and its input is the emitted bytes.** The Oxy
 *    signature is over `canonicalize(bundle minus attestation)`, so any change to
 *    a field's TYPE — a `Date` where the wire promised an ISO string — changes
 *    the signing input. Every timestamp's emitted TYPE is asserted, not just its
 *    value.
 * 3. **The bundle is reproducible.** Two exports of an unchanged account must
 *    order their child rows identically; heap order would make the same account
 *    produce two different signatures.
 * 4. **The social graph comes from `user_follows`.** The Mongo `following[]` /
 *    `followers[]` arrays are DELETED by the schema, so an export that still
 *    read them would silently ship an empty graph.
 *
 * The suite this replaces stubbed `User.findById`, `SignedRecord.find` and
 * `UserAppData.find`, so the secret-stripping assertion only proved that
 * `formatUserResponse` drops fields from an object a test literal handed it —
 * never that the QUERY refuses to load them. Here the columns are real, and
 * `publicColumns(users)` is what keeps them out.
 *
 * The real `usersRouter`, the real `identityExport.service`, the real
 * `user.service` and the real `SignatureService` all run. Only heavy deps
 * unrelated to the export path are stubbed, so the router module can load.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { ec as EC } from 'elliptic';
import { eq } from 'drizzle-orm';
import { canonicalize } from '@oxyhq/protocol';
import { exportBundleSchema, type SignedRecordEnvelope } from '@oxyhq/contracts';

/** The account `authMiddleware` injects for the current test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: () => currentUserId,
}));

// Unrelated collaborators of the users router — stubbed only so the module loads.
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn() },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn() },
  s3Service: {},
}));
jest.mock('../../controllers/users.controller', () => ({
  UsersController: class { searchUsers = jest.fn(); },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signedRecords } from '../../db/schema/signedRecords';
import { userAppData } from '../../db/schema/userAppData';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import SignatureService from '../../services/signature.service';
import usersRouter from '../users';
import { errorHandler } from '../../middleware/errorHandler';

const ec = new EC('secp256k1');
const oxyKey = ec.genKeyPair();
const OXY_PUBLIC_KEY = oxyKey.getPublic('hex');
const OXY_PRIVATE_KEY = oxyKey.getPrivate('hex');

/** The two ids the `text` primary key can hold; only one of them is minted now. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Secret values seeded onto the account row. Every one is a column Mongoose
 * declared `select: false` (`db/schema/protectedColumns.ts`), and none may
 * appear anywhere in the export.
 */
const SECRETS = {
  phone: '+34600111222',
  refreshToken: 'refresh-secret-value',
  emailSignature: 'signature-secret-value',
  autoForwardTo: 'forward-secret@example.com',
} as const;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: string;
}

function getRaw(path: string): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw }));
    }).on('error', reject);
  });
}

/** A bare account row, made the CURRENT caller. */
async function signInAsFreshAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '')}` })
    .returning({ id: users.id });
  currentUserId = row.id;
  return row.id;
}

/** A v1 signed-record envelope for `userId`. */
function envelopeFor(userId: string, type: 'identity' | 'profile', publicKey: string): SignedRecordEnvelope {
  return {
    version: 1,
    type,
    subject: `did:web:oxy.so:u:${userId}`,
    issuer: `did:web:oxy.so:u:${userId}`,
    record: { kind: type },
    issuedAt: 1_800_000_000_000,
    publicKey,
    alg: 'ES256K-DER-SHA256',
    signature: 'deadbeef',
  };
}

/**
 * A fully-populated account: profile fields, SECRETS, an identity key, a
 * passkey, two verified domains, two app-data entries, a follow in each
 * direction, and one signed record per type.
 */
async function seedFullAccount(): Promise<{ userId: string; publicKey: string; followedId: string; followerId: string }> {
  const db = getDb();
  const publicKey = ec.genKeyPair().getPublic('hex');
  const username = `nate${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const [row] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@oxy.so`,
      publicKey,
      nameFirst: 'Nate',
      nameLast: 'Isern',
      avatar: 'file-1',
      color: 'purple',
      bio: 'Building Oxy',
      verified: true,
      languages: ['en-US'],
      themePreferenceMode: 'dark',
      themePreferenceColorPreset: 'purple',
      ...SECRETS,
    })
    .returning({ id: users.id, createdAt: users.createdAt });
  const userId = row.id;
  currentUserId = userId;

  await db.insert(userAuthMethods).values([
    {
      userId,
      type: 'identity',
      methodPublicKey: publicKey,
      linkedAt: new Date('2026-05-01T00:00:00.000Z'),
    },
    {
      userId,
      type: 'webauthn',
      methodCredentialId: `cred${randomUUID().replace(/-/g, '')}`,
      methodName: 'Laptop',
      linkedAt: new Date('2026-05-02T00:00:00.000Z'),
    },
  ]);

  await db.insert(userVerifiedDomains).values([
    { userId, domain: 'first.example', verifiedAt: new Date('2026-06-01T00:00:00.000Z'), method: 'dns-txt', createdAt: new Date('2026-06-01T00:00:00.000Z') },
    { userId, domain: 'second.example', verifiedAt: new Date('2026-06-02T00:00:00.000Z'), method: 'well-known', createdAt: new Date('2026-06-02T00:00:00.000Z') },
  ]);

  await db.insert(userAppData).values([
    { userId, namespace: 'academy', key: 'progress', value: { done: 3 } },
    { userId, namespace: 'academy', key: 'bookmarks', value: [] },
  ]);

  const [followed] = await db.insert(users).values({ username: `f${randomUUID().replace(/-/g, '')}` }).returning({ id: users.id });
  const [follower] = await db.insert(users).values({ username: `g${randomUUID().replace(/-/g, '')}` }).returning({ id: users.id });
  await db.insert(userFollows).values({ followerId: userId, followedId: followed.id });
  await db.insert(userFollows).values({ followerId: follower.id, followedId: userId });

  await db.insert(signedRecords).values([
    {
      subjectDid: `did:web:oxy.so:u:${userId}`,
      userId,
      type: 'identity',
      envelope: envelopeFor(userId, 'identity', publicKey),
      publicKey,
      verified: true,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    },
    {
      subjectDid: `did:web:oxy.so:u:${userId}`,
      userId,
      type: 'profile',
      envelope: envelopeFor(userId, 'profile', publicKey),
      publicKey,
      verified: true,
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    },
  ]);

  return { userId, publicKey, followedId: followed.id, followerId: follower.id };
}

let server: http.Server;
const ORIGINAL_PRIVATE_KEY = process.env.OXY_PRIVATE_KEY;
const ORIGINAL_PUBLIC_KEY = process.env.OXY_PUBLIC_KEY;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE_KEY;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC_KEY;
});

afterEach(() => {
  if (ORIGINAL_PRIVATE_KEY === undefined) delete process.env.OXY_PRIVATE_KEY;
  else process.env.OXY_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY;
  if (ORIGINAL_PUBLIC_KEY === undefined) delete process.env.OXY_PUBLIC_KEY;
  else process.env.OXY_PUBLIC_KEY = ORIGINAL_PUBLIC_KEY;
});

describe('the export bundle must not leak a secret', () => {
  it('omits every protected column, by value and by field name', async () => {
    const { userId } = await seedFullAccount();

    const res = await getRaw('/users/me/export');
    expect(res.status).toBe(200);

    // Byte-level: no secret VALUE appears anywhere in the serialized bundle,
    // whatever field it might have travelled in.
    for (const secret of Object.values(SECRETS)) {
      expect(res.raw).not.toContain(secret);
    }

    const bundle = JSON.parse(res.raw);
    const profile = bundle.profile as Record<string, unknown>;
    for (const field of ['phone', 'hashedEmail', 'hashedPhone', 'refreshToken', 'emailSignature', 'autoForwardTo', 'autoForwardKeepCopy', 'password', 'twoFactorAuth']) {
      expect(profile[field]).toBeUndefined();
    }

    // The account really does hold those secrets — otherwise the assertions
    // above pass against an empty row and prove nothing.
    const [stored] = await getDb()
      .select({ phone: users.phone, hashedEmail: users.hashedEmail, refreshToken: users.refreshToken })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(stored.phone).toBe(SECRETS.phone);
    expect(stored.refreshToken).toBe(SECRETS.refreshToken);
    // `hashed_email` is a GENERATED column: it exists without anyone writing it,
    // which is exactly why the export must exclude it explicitly.
    expect(stored.hashedEmail).toMatch(/^[0-9a-f]{64}$/);
    expect(res.raw).not.toContain(stored.hashedEmail);
  });
});

describe('GET /users/me/export (JSON)', () => {
  it('serves a contract-valid bundle assembled from the stored rows', async () => {
    const { userId, publicKey, followedId, followerId } = await seedFullAccount();
    const did = `did:web:oxy.so:u:${userId}`;

    const res = await getRaw('/users/me/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('oxy-identity-export-');

    const bundle = JSON.parse(res.raw);
    expect(bundle.$schema).toBe('https://oxy.so/schemas/identity-export/v1');
    expect(bundle.did).toBe(did);
    expect(bundle.didDocument.id).toBe(did);
    expect(bundle.didDocument.controller).toEqual([did, 'did:web:oxy.so']);
    expect(bundle.didDocument.verificationMethod).toEqual([
      { id: `${did}#key-1`, type: 'EcdsaSecp256k1VerificationKey2019', controller: did, publicKeyHex: publicKey },
    ]);
    expect(bundle.didDocument.alsoKnownAs).toEqual(expect.arrayContaining([
      'https://first.example',
      'https://second.example',
    ]));

    expect(bundle.verifiedDomains).toEqual([
      { domain: 'first.example', verifiedAt: '2026-06-01T00:00:00.000Z', method: 'dns-txt' },
      { domain: 'second.example', verifiedAt: '2026-06-02T00:00:00.000Z', method: 'well-known' },
    ]);

    expect(bundle.authMethods).toEqual([
      { type: 'identity', linkedAt: '2026-05-01T00:00:00.000Z', verificationMethodId: '#key-1' },
      { type: 'webauthn', linkedAt: '2026-05-02T00:00:00.000Z', credentialId: expect.any(String), name: 'Laptop' },
    ]);

    // `namespace, key` — the order Mongo's `{userId, namespace, key}` index gave.
    expect(bundle.appData).toEqual([
      { namespace: 'academy', key: 'bookmarks', value: [] },
      { namespace: 'academy', key: 'progress', value: { done: 3 } },
    ]);

    // The social graph is `user_follows`, the schema's single authority — the
    // embedded `following[]`/`followers[]` arrays no longer exist.
    expect(bundle.social).toEqual({
      following: [`did:web:oxy.so:u:${followedId}`],
      followers: [`did:web:oxy.so:u:${followerId}`],
    });

    expect(bundle.signedRecords).toHaveLength(2);
    expect(bundle.signedRecords.map((record: SignedRecordEnvelope) => record.type)).toEqual(['identity', 'profile']);

    expect(bundle.profile.id).toBe(userId);
    expect(bundle.profile.publicKey).toBe(publicKey);
    expect(bundle.profile.name).toEqual({ displayName: 'Nate Isern', first: 'Nate', last: 'Isern', full: 'Nate Isern' });
    expect(bundle.profile.verified).toBe(true);
    expect(bundle.profile.themePreference).toEqual({ mode: 'dark', colorPreset: 'purple' });
    // The privacy settings ride the profile section; every key is present
    // because the columns are NOT NULL with defaults.
    expect(bundle.profile.privacySettings).toMatchObject({ isPrivateAccount: false, fediverseSharing: true });

    expect(exportBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('emits every timestamp as an ISO STRING — the signature input depends on it', async () => {
    // `db.execute` bypasses drizzle's column mappers and a `timestamptz` then
    // comes back as the raw string `2026-07-31 20:36:11.044179+00`, which
    // `res.json` serializes as happily as a Date. The emitted TYPE is therefore
    // asserted, not just the value.
    await seedFullAccount();

    const bundle = JSON.parse((await getRaw('/users/me/export')).raw);

    expect(typeof bundle.exportedAt).toBe('string');
    expect(bundle.exportedAt).toMatch(ISO_8601);
    expect(bundle.verifiedDomains[0].verifiedAt).toMatch(ISO_8601);
    expect(bundle.authMethods[0].linkedAt).toMatch(ISO_8601);
    expect(bundle.profile.createdAt).toMatch(ISO_8601);
    expect(bundle.profile.updatedAt).toMatch(ISO_8601);
    expect(typeof bundle.attestation.signedAt).toBe('number');
  });

  it('seals an Oxy attestation that verifies over the emitted bytes', async () => {
    await seedFullAccount();

    const bundle = JSON.parse((await getRaw('/users/me/export')).raw);

    expect(bundle.attestation).not.toBeNull();
    expect(bundle.attestation.issuer).toBe('did:web:oxy.so');
    expect(bundle.attestation.publicKey).toBe(OXY_PUBLIC_KEY);
    expect(bundle.attestation.alg).toBe('ES256K-DER-SHA256');

    const { attestation, proof, ...signed } = bundle;
    expect(proof).toBeUndefined();
    expect(
      SignatureService.verifySignature(canonicalize(signed), attestation.signature, OXY_PUBLIC_KEY),
    ).toBe(true);
  });

  it('produces the SAME bytes twice for an unchanged account', async () => {
    // Reproducibility is what makes the attestation checkable by a third party:
    // an unordered child-table read would give the same account two signatures.
    await seedFullAccount();

    const first = JSON.parse((await getRaw('/users/me/export')).raw);
    const second = JSON.parse((await getRaw('/users/me/export')).raw);

    // `exportedAt` and the attestation are the only fields that legitimately
    // move between two exports.
    const { attestation: _a, exportedAt: _e, ...firstBody } = first;
    const { attestation: _b, exportedAt: _f, ...secondBody } = second;
    expect(canonicalize(secondBody)).toBe(canonicalize(firstBody));
  });

  it('serves the bundle with attestation: null when no Oxy signing key is configured', async () => {
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    await seedFullAccount();

    const res = await getRaw('/users/me/export');

    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.raw);
    expect(bundle.attestation).toBeNull();
    // The no-key bundle MUST still conform: `exportBundleSchema.attestation` is
    // nullable, and the route parses its own output before responding.
    expect(exportBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('exports an account with no child rows at all', async () => {
    // A brand-new account has no domains, no auth methods, no app data and no
    // follows. Every section must be an empty ARRAY — the contract has no
    // nullable list, and drizzle hands back `null` where Mongoose handed
    // `undefined`, so an absent section would fail the SDK's zod parse.
    await signInAsFreshAccount();

    const bundle = JSON.parse((await getRaw('/users/me/export')).raw);

    expect(bundle.verifiedDomains).toEqual([]);
    expect(bundle.authMethods).toEqual([]);
    expect(bundle.signedRecords).toEqual([]);
    expect(bundle.appData).toEqual([]);
    expect(bundle.social).toEqual({ following: [], followers: [] });
    expect(bundle.didDocument.verificationMethod).toEqual([
      {
        id: 'did:web:oxy.so#oxy-custodial-key',
        type: 'EcdsaSecp256k1VerificationKey2019',
        controller: 'did:web:oxy.so',
        publicKeyHex: OXY_PUBLIC_KEY,
      },
    ]);
    expect(exportBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('exports an account whose id the deleted 24-hex guard would have rejected', async () => {
    const { userId } = await seedFullAccount();

    expect(userId).not.toMatch(OBJECT_ID_HEX);
    const bundle = JSON.parse((await getRaw('/users/me/export')).raw);
    expect(bundle.did).toBe(`did:web:oxy.so:u:${userId}`);
  });

  it('returns 404 when the account does not exist', async () => {
    currentUserId = randomUUID();

    const res = await getRaw('/users/me/export');

    expect(res.status).toBe(404);
    expect(JSON.parse(res.raw)).toEqual({ error: 'NOT_FOUND', message: 'User not found' });
  });
});

describe('GET /users/me/export?format=ndjson', () => {
  it('streams the sections as newline-delimited JSON', async () => {
    const { userId, followedId, followerId } = await seedFullAccount();

    const res = await getRaw('/users/me/export?format=ndjson');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const lines = res.raw.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0].kind).toBe('meta');
    expect(lines[0].did).toBe(`did:web:oxy.so:u:${userId}`);
    expect(lines[0].verifiedDomains).toHaveLength(2);
    expect(lines.filter((line) => line.kind === 'signedRecord')).toHaveLength(2);
    expect(lines.filter((line) => line.kind === 'appData')).toHaveLength(2);
    expect(lines.filter((line) => line.kind === 'following')).toEqual([
      { kind: 'following', did: `did:web:oxy.so:u:${followedId}` },
    ]);
    expect(lines.filter((line) => line.kind === 'follower')).toEqual([
      { kind: 'follower', did: `did:web:oxy.so:u:${followerId}` },
    ]);
    expect(lines[lines.length - 1].kind).toBe('attestation');
    expect(lines[lines.length - 1].attestation.publicKey).toBe(OXY_PUBLIC_KEY);
  });

  it('leaks no secret through the streamed form either', async () => {
    await seedFullAccount();

    const res = await getRaw('/users/me/export?format=ndjson');

    for (const secret of Object.values(SECRETS)) {
      expect(res.raw).not.toContain(secret);
    }
  });
});
