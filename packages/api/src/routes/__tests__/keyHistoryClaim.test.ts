/**
 * `POST /identity/key-history/claim` and the backfill (security review R6-5),
 * against a REAL Postgres.
 *
 * A root a rotation replaced before migration 0235 has no history row, so
 * Commons cannot bind the key it keeps quarantined. The claim adds it only with
 * BOTH proofs: the caller signs with the key (possession), and Oxy's OWN
 * records — verified, self-issued `signed_records` the account wrote with it —
 * show it was this account's. These cases pin each half and every exclusion,
 * reading the stored history rows.
 */

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import express from 'express';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { IDENTITY_ERROR_CODES, ORGANIZATION_KEY_OPERATIONS } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { organizationIdentityKeys } from '../../db/schema/organizationIdentityKeys';
import { personalIdentityKeyRetirements } from '../../db/schema/personalIdentityKeyRetirements';
import { signedRecords } from '../../db/schema/signedRecords';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { buildUserDid, OXY_DID } from '../../services/did.service';
import { backfillPersonalKeyRetirements } from '../../services/personalKeyEvidence';
import SignatureService from '../../services/signature.service';
import identityProofRouter from '../identityProof';

let server: http.Server;

async function request(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

/** A personal account whose CURRENT root is a fresh key. */
async function personWithRoot(): Promise<string> {
  const root = generateSecp256k1KeyPair().publicKey;
  const [row] = await getDb().insert(users).values({ publicKey: root }).returning({ id: users.id });
  return row.id;
}

/** A verified signed record `userId` wrote with `publicKey` (self-issued unless `custodial`). */
async function signedRecordBy(
  userId: string,
  publicKey: string,
  options: { custodial?: boolean; verified?: boolean } = {},
): Promise<Date> {
  const did = buildUserDid(userId);
  const [row] = await getDb()
    .insert(signedRecords)
    .values({
      subjectDid: did,
      userId,
      type: 'profile',
      envelope: {
        version: 1,
        type: 'profile',
        subject: did,
        issuer: options.custodial ? OXY_DID : did,
        publicKey,
        issuedAt: Date.now(),
        payload: {},
        signature: 'sig',
      } as never,
      publicKey,
      verified: options.verified ?? true,
    })
    .returning({ createdAt: signedRecords.createdAt });
  return row.createdAt;
}

function claimBody(
  userId: string,
  key: { publicKey: string; privateKey: string },
  timestamp = Date.now(),
): Record<string, unknown> {
  const message = JSON.stringify({
    action: 'claim_retired_identity_key',
    userId,
    publicKey: key.publicKey,
    timestamp,
  });
  return {
    publicKey: key.publicKey,
    signature: SignatureService.signMessage(message, key.privateKey),
    timestamp,
  };
}

async function historyRows(publicKey: string) {
  return getDb()
    .select({
      userId: personalIdentityKeyRetirements.userId,
      retiredAt: personalIdentityKeyRetirements.retiredAt,
    })
    .from(personalIdentityKeyRetirements)
    .where(eq(personalIdentityKeyRetirements.publicKey, publicKey));
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity', identityProofRouter);
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

beforeEach(async () => {
  currentUserId = await personWithRoot();
});

describe('POST /identity/key-history/claim', () => {
  it("adds a key the account's own verified, self-issued records show, at their latest time", async () => {
    const old = generateSecp256k1KeyPair();
    const seenAt = await signedRecordBy(currentUserId, old.publicKey);

    const res = await request('/identity/key-history/claim', claimBody(currentUserId, old));
    expect(res.status).toBe(200);
    expect(res.body.retired).toEqual([
      { publicKey: old.publicKey, retiredAt: seenAt.toISOString() },
    ]);
    expect(await historyRows(old.publicKey)).toEqual([
      { userId: currentUserId, retiredAt: seenAt },
    ]);

    // Idempotent: a second claim answers the same history, one row.
    const again = await request('/identity/key-history/claim', claimBody(currentUserId, old));
    expect(again.status).toBe(200);
    expect(await historyRows(old.publicKey)).toHaveLength(1);
  });

  it('refuses without possession: a signature by another key, or a stale timestamp (400)', async () => {
    const old = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, old.publicKey);
    const other = generateSecp256k1KeyPair();
    const forged = {
      ...claimBody(currentUserId, other),
      publicKey: old.publicKey,
    };
    expect((await request('/identity/key-history/claim', forged)).status).toBe(400);
    const stale = claimBody(currentUserId, old, Date.now() - 10 * 60 * 1000);
    expect((await request('/identity/key-history/claim', stale)).status).toBe(400);
    expect(await historyRows(old.publicKey)).toEqual([]);
  });

  it('refuses a signature made for another account (the userId is signed)', async () => {
    const old = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, old.publicKey);
    const body = claimBody(randomUUID(), old);
    expect((await request('/identity/key-history/claim', body)).status).toBe(400);
  });

  it('a key no record of Oxy shows is 404 IDENTITY_KEY_NOT_PROVEN', async () => {
    const res = await request(
      '/identity/key-history/claim',
      claimBody(currentUserId, generateSecp256k1KeyPair()),
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain(IDENTITY_ERROR_CODES.keyNotProven);
  });

  it('custodial or unverified records prove nothing (404)', async () => {
    const custodial = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, custodial.publicKey, { custodial: true });
    const unverified = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, unverified.publicKey, { verified: false });
    for (const key of [custodial, unverified]) {
      const res = await request('/identity/key-history/claim', claimBody(currentUserId, key));
      expect(res.status).toBe(404);
      expect(await historyRows(key.publicKey)).toEqual([]);
    }
  });

  it("another account's records prove nothing for this one (404), and a key both show is never added", async () => {
    const theirs = generateSecp256k1KeyPair();
    const other = await personWithRoot();
    await signedRecordBy(other, theirs.publicKey);
    expect(
      (await request('/identity/key-history/claim', claimBody(currentUserId, theirs))).status,
    ).toBe(404);

    // Both accounts' records show it: whose it was is not Oxy's to decide.
    await signedRecordBy(currentUserId, theirs.publicKey);
    expect(
      (await request('/identity/key-history/claim', claimBody(currentUserId, theirs))).status,
    ).toBe(404);
    expect(await historyRows(theirs.publicKey)).toEqual([]);
  });

  it("the account's current root is 409", async () => {
    const root = generateSecp256k1KeyPair();
    await getDb()
      .update(users)
      .set({ publicKey: root.publicKey })
      .where(eq(users.id, currentUserId));
    await signedRecordBy(currentUserId, root.publicKey);
    const res = await request('/identity/key-history/claim', claimBody(currentUserId, root));
    expect(res.status).toBe(409);
  });

  it("another account's live identity key is never added (404)", async () => {
    const live = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, live.publicKey);
    const other = await personWithRoot();
    await getDb()
      .insert(userAuthMethods)
      .values({ userId: other, type: 'identity', methodPublicKey: live.publicKey });
    const res = await request('/identity/key-history/claim', claimBody(currentUserId, live));
    expect(res.status).toBe(404);
  });

  it("a key in another account's history is 409", async () => {
    const retired = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, retired.publicKey);
    const other = await personWithRoot();
    await getDb()
      .insert(personalIdentityKeyRetirements)
      .values({ userId: other, publicKey: retired.publicKey });
    const res = await request('/identity/key-history/claim', claimBody(currentUserId, retired));
    expect(res.status).toBe(409);
    expect(await historyRows(retired.publicKey)).toEqual([
      expect.objectContaining({ userId: other }),
    ]);
  });

  it("an organization's key is never a person's retired root (404)", async () => {
    const orgKey = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, orgKey.publicKey);
    await getDb()
      .insert(organizationIdentityKeys)
      .values({ publicKey: orgKey.publicKey, method: ORGANIZATION_KEY_OPERATIONS[0] });
    const res = await request('/identity/key-history/claim', claimBody(currentUserId, orgKey));
    expect(res.status).toBe(404);
  });

  it('refuses a non-personal account (403) and a body with an extra field (400)', async () => {
    const key = generateSecp256k1KeyPair();
    const extra = { ...claimBody(currentUserId, key), userId: currentUserId };
    expect((await request('/identity/key-history/claim', extra)).status).toBe(400);

    const [org] = await insertAccountFixtures(
      { kind: 'organization', publicKey: generateSecp256k1KeyPair().publicKey },
      { id: users.id },
    );
    currentUserId = org.id;
    const res = await request('/identity/key-history/claim', claimBody(currentUserId, key));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain(IDENTITY_ERROR_CODES.notPersonal);
  });
});

describe('backfillPersonalKeyRetirements', () => {
  it('adds every proven key only with apply, and a second run adds nothing', async () => {
    const old = generateSecp256k1KeyPair();
    await signedRecordBy(currentUserId, old.publicKey);

    const dry = await backfillPersonalKeyRetirements(getDb(), { apply: false });
    expect(dry.proven).toBeGreaterThanOrEqual(1);
    expect(dry.inserted).toBe(0);
    expect(await historyRows(old.publicKey)).toEqual([]);

    const applied = await backfillPersonalKeyRetirements(getDb(), { apply: true });
    expect(applied.inserted).toBe(applied.proven);
    expect(await historyRows(old.publicKey)).toEqual([
      expect.objectContaining({ userId: currentUserId }),
    ]);

    const again = await backfillPersonalKeyRetirements(getDb(), { apply: true });
    expect(again.inserted).toBe(0);
  });
});
