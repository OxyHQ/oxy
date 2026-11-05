/**
 * ADR 0061 D2: an organization's identity key is its DID `#key-1`, never a way
 * in. `POST /auth/challenge` answers it like a key nobody holds, and
 * `POST /auth/verify` mints nothing for it even with a valid signature and a
 * live challenge. Real Postgres, real secp256k1.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
const mockCreateSession = jest.fn();
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: (...args: unknown[]) => mockCreateSession(...args) },
}));
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
import { authChallenges } from '../../db/schema/authChallenges';
import SignatureService from '../../services/signature.service';
import { SessionController } from '../session.controller';

interface Captured {
  status: number;
  body: unknown;
}
function response(): { res: Response; captured: Captured } {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

beforeAll(connectPostgres);
afterAll(closePostgres);

it('POST /auth/challenge answers an organization key like an unknown one; a personal key gets a challenge', async () => {
  const orgKey = generateSecp256k1KeyPair();
  await insertAccountFixture({ kind: 'organization', publicKey: orgKey.publicKey });
  const refused = response();
  await SessionController.requestChallenge(
    { body: { publicKey: orgKey.publicKey } } as Request,
    refused.res,
  );
  const unknown = response();
  await SessionController.requestChallenge(
    { body: { publicKey: generateSecp256k1KeyPair().publicKey } } as Request,
    unknown.res,
  );
  expect(refused.captured).toEqual(unknown.captured);
  expect(refused.captured.status).toBe(404);
  expect(
    await getDb()
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.publicKey, orgKey.publicKey)),
  ).toEqual([]);

  const personKey = generateSecp256k1KeyPair();
  await insertAccountFixture({ kind: 'personal', publicKey: personKey.publicKey });
  const allowed = response();
  await SessionController.requestChallenge(
    { body: { publicKey: personKey.publicKey } } as Request,
    allowed.res,
  );
  expect(allowed.captured.status).toBe(200);
});

it('POST /auth/verify mints no session for an organization key', async () => {
  const orgKey = generateSecp256k1KeyPair();
  await insertAccountFixture({ kind: 'organization', publicKey: orgKey.publicKey });
  const challenge = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(authChallenges)
    .values({
      publicKey: orgKey.publicKey,
      challenge,
      expiresAt: new Date(Date.now() + 60_000),
    });
  const timestamp = Date.now();
  const signature = SignatureService.signMessage(
    `auth:${orgKey.publicKey}:${challenge}:${timestamp}`,
    orgKey.privateKey,
  );
  const { res, captured } = response();
  await SessionController.verifyChallenge(
    { body: { publicKey: orgKey.publicKey, challenge, signature, timestamp } } as Request,
    res,
  );
  expect(captured.status).toBe(404);
  expect(mockCreateSession).not.toHaveBeenCalled();
});
