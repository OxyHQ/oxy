import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
/**
 * ADR 0061: an organization's identity key, against real Postgres and real
 * secp256k1. Every assertion reads what was stored.
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import {
  IDENTITY_ERROR_CODES,
  ORGANIZATION_KEY_ERROR_CODES,
  buildIdentityProofMessage,
  organizationKeyProofClaims,
  type OrganizationKeyChallenge,
  type OrganizationKeyOperation,
} from '@oxy.so/contracts';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountMembers } from '../../db/schema/accountMembers';
import { organizationProfiles } from '../../db/schema/organizationProfiles';
import { organizationIdentityKeys } from '../../db/schema/organizationIdentityKeys';
import { personalIdentityKeyRetirements } from '../../db/schema/personalIdentityKeyRetirements';
import { identityProofChallenges } from '../../db/schema/identityProofChallenges';
import { securityActivities } from '../../db/schema/securityActivities';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { userAncestors } from '../../db/schema/userAncestors';
import SignatureService from '../signature.service';
import sessionService from '../session.service';
import { buildDidDocument } from '../did.service';
import { createPersonalAccount } from '../accountCreation.service';
import type { CanonicalUsername } from '../accountCreation.service';
import {
  applyOrganizationKey,
  readOrganizationIdentityKey,
  requestOrganizationKeyChallenge,
} from '../organizationIdentityKey.service';
import { sha256Hex } from '../identityProof.service';

const request = { headers: { 'user-agent': 'org-key-fixture' } } as Request;

interface Key {
  privateKey: string;
  publicKey: string;
}
function newKey(): Key {
  return generateSecp256k1KeyPair();
}

async function person(withRoot = true) {
  const key = newKey();
  const [row] = await insertAccountFixtures(
    { kind: 'personal', ...(withRoot ? { publicKey: key.publicKey } : {}) },
    { id: users.id },
  );
  const session = await sessionService.createSession(row.id, request, { deviceId: randomUUID() });
  return { id: row.id, key, sessionId: session.sessionId };
}

async function organization(kind: 'organization' | 'project' = 'organization') {
  const [row] = await insertAccountFixtures({ kind }, { id: users.id });
  return row.id;
}

async function member(accountId: string, userId: string, role: 'owner' | 'admin' | 'editor') {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId: userId, role, status: 'active' });
}

function sign(challenge: OrganizationKeyChallenge, signer: Key): string {
  return SignatureService.signMessage(
    buildIdentityProofMessage(organizationKeyProofClaims(challenge, signer.publicKey)),
    signer.privateKey,
  );
}

/** One ceremony as Commons runs it: challenge, then the signatures. */
async function change(
  actor: { key: Key; sessionId: string },
  accountId: string,
  operation: OrganizationKeyOperation,
  key: Key,
  options: { previous?: Key; signKeyWith?: Key } = {},
) {
  const challenge = await requestOrganizationKeyChallenge(actor.sessionId, accountId, {
    operation,
    publicKey: key.publicKey,
  });
  const body = {
    operation,
    publicKey: key.publicKey,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
    actorSignature: sign(challenge, actor.key),
    keySignature: sign(challenge, options.signKeyWith ?? key),
    ...(options.previous ? { previousKeySignature: sign(challenge, options.previous) } : {}),
  };
  return { challenge, body, apply: () => applyOrganizationKey(actor.sessionId, accountId, body) };
}

async function storedKey(accountId: string) {
  const [row] = await getDb()
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, accountId));
  return row?.publicKey ?? null;
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
});
afterAll(closePostgres);

it('a keyless organization answers no key, and its DID has no #key-1', async () => {
  const owner = await person();
  const org = await organization();
  await member(org, owner.id, 'owner');
  await expect(readOrganizationIdentityKey(owner.sessionId, org)).resolves.toEqual({
    accountId: org,
    publicKey: null,
    keys: [],
  });
  const did = buildDidDocument({ _id: org, publicKey: await storedKey(org) });
  expect(did.verificationMethod.some((method) => method.id.endsWith('#key-1'))).toBe(false);
});

it('an owner creates the key: it becomes the DID #key-1, with history and audit, and no sign-in method', async () => {
  const owner = await person();
  const org = await organization();
  await member(org, owner.id, 'owner');
  const orgKey = newKey();
  const { apply } = await change(owner, org, 'create', orgKey);
  const state = await apply();

  expect(state.publicKey).toBe(orgKey.publicKey);
  expect(state.keys).toEqual([
    expect.objectContaining({
      publicKey: orgKey.publicKey,
      method: 'create',
      linkedByUserId: owner.id,
      previousKeyProven: false,
      retiredAt: null,
    }),
  ]);
  expect(await storedKey(org)).toBe(orgKey.publicKey);
  const did = buildDidDocument({ _id: org, publicKey: await storedKey(org) });
  expect(did.controller).toEqual([did.id]);
  expect(did.verificationMethod.find((method) => method.id === `${did.id}#key-1`)).toEqual(
    expect.objectContaining({ publicKeyHex: orgKey.publicKey }),
  );
  expect(
    await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, org)),
  ).toEqual([]);
  const [audit] = await getDb()
    .select({ metadata: securityActivities.metadata })
    .from(securityActivities)
    .where(eq(securityActivities.userId, org));
  expect(audit.metadata).toEqual(
    expect.objectContaining({ action: 'organization_key.create', actorAccountId: owner.id }),
  );
  await expect(readOrganizationIdentityKey(owner.sessionId, org)).resolves.toEqual(state);
});

it('an admin may, inherited from a parent too; an editor, a non-member and the wrong kinds may not', async () => {
  const admin = await person();
  const editor = await person();
  const stranger = await person();
  const org = await organization();
  await member(org, admin.id, 'admin');
  await member(org, editor.id, 'editor');
  await expect(readOrganizationIdentityKey(admin.sessionId, org)).resolves.toMatchObject({
    publicKey: null,
  });
  for (const actor of [editor, stranger]) {
    await expect(readOrganizationIdentityKey(actor.sessionId, org)).rejects.toMatchObject({
      statusCode: 403,
      code: ORGANIZATION_KEY_ERROR_CODES.forbidden,
    });
    await expect(change(actor, org, 'create', newKey())).rejects.toMatchObject({ statusCode: 403 });
  }

  const parent = await organization();
  const child = await organization();
  await getDb().insert(userAncestors).values({ userId: child, ancestorId: parent, depth: 0 });
  await member(parent, stranger.id, 'owner');
  await expect((await change(stranger, child, 'create', newKey())).apply()).resolves.toMatchObject({
    accountId: child,
  });

  const project = await organization('project');
  await member(project, admin.id, 'owner');
  await expect(readOrganizationIdentityKey(admin.sessionId, project)).rejects.toMatchObject({
    statusCode: 403,
  });
  const unclaimed = await organization();
  await member(unclaimed, admin.id, 'owner');
  await getDb()
    .update(organizationProfiles)
    .set({ claimStatus: 'unclaimed' })
    .where(eq(organizationProfiles.accountId, unclaimed));
  await expect(readOrganizationIdentityKey(admin.sessionId, unclaimed)).rejects.toMatchObject({
    statusCode: 403,
  });
});

it('a person without a root of their own may read but not sign', async () => {
  const owner = await person(false);
  const org = await organization();
  await member(org, owner.id, 'owner');
  await expect(readOrganizationIdentityKey(owner.sessionId, org)).resolves.toMatchObject({
    publicKey: null,
  });
  await expect(
    requestOrganizationKeyChallenge(owner.sessionId, org, {
      operation: 'create',
      publicKey: newKey().publicKey,
    }),
  ).rejects.toMatchObject({
    statusCode: 403,
    code: ORGANIZATION_KEY_ERROR_CODES.actorRootRequired,
  });
});

it('every signature is required, and a refused proof leaves the challenge spendable once', async () => {
  const owner = await person();
  const org = await organization();
  await member(org, owner.id, 'owner');
  const orgKey = newKey();
  const forged = await change(owner, org, 'create', orgKey, { signKeyWith: newKey() });
  await expect(forged.apply()).rejects.toMatchObject({
    statusCode: 401,
    code: IDENTITY_ERROR_CODES.proofInvalid,
  });
  const notTheActor = { ...forged.body, actorSignature: sign(forged.challenge, newKey()) };
  notTheActor.keySignature = sign(forged.challenge, orgKey);
  await expect(applyOrganizationKey(owner.sessionId, org, notTheActor)).rejects.toMatchObject({
    statusCode: 401,
  });
  const [unspent] = await getDb()
    .select({ usedAt: identityProofChallenges.usedAt })
    .from(identityProofChallenges)
    .where(eq(identityProofChallenges.challengeHash, sha256Hex(forged.challenge.challenge)));
  expect(unspent.usedAt).toBeNull();

  const honest = { ...notTheActor, actorSignature: sign(forged.challenge, owner.key) };
  await expect(applyOrganizationKey(owner.sessionId, org, honest)).resolves.toMatchObject({
    publicKey: orgKey.publicKey,
  });
  await expect(applyOrganizationKey(owner.sessionId, org, honest)).rejects.toMatchObject({
    statusCode: 409,
    code: IDENTITY_ERROR_CODES.rootAlreadyLinked,
  });
  expect(await storedKey(org)).toBe(orgKey.publicKey);
});

it('replacing retires the key for good; the current key is optional and recorded', async () => {
  const owner = await person();
  const admin = await person();
  const org = await organization();
  await member(org, owner.id, 'owner');
  await member(org, admin.id, 'admin');
  await expect(change(owner, org, 'replace', newKey())).rejects.toMatchObject({
    statusCode: 409,
    code: ORGANIZATION_KEY_ERROR_CODES.noKey,
  });
  const first = newKey();
  await (await change(owner, org, 'create', first)).apply();
  await expect(change(owner, org, 'create', newKey())).rejects.toMatchObject({ statusCode: 409 });

  // The only holder is gone: an admin replaces it without the current key.
  const second = newKey();
  const replaced = await (await change(admin, org, 'replace', second)).apply();
  expect(replaced.publicKey).toBe(second.publicKey);
  expect(
    replaced.keys.map((key) => [
      key.publicKey,
      key.method,
      key.previousKeyProven,
      key.retiredAt === null,
    ]),
  ).toEqual([
    [first.publicKey, 'create', false, false],
    [second.publicKey, 'replace', false, true],
  ]);
  // With the current key it is recorded as proven.
  const third = newKey();
  const proven = await (await change(owner, org, 'replace', third, { previous: second })).apply();
  expect(proven.keys.at(-1)).toMatchObject({ publicKey: third.publicKey, previousKeyProven: true });
  // A wrong current-key signature is refused, not ignored.
  await expect(
    (await change(owner, org, 'replace', newKey(), { previous: first })).apply(),
  ).rejects.toMatchObject({ statusCode: 401 });

  // A retired key is never another account's.
  const other = await organization();
  await member(other, owner.id, 'owner');
  await expect(change(owner, other, 'create', first)).rejects.toMatchObject({
    statusCode: 409,
    code: ORGANIZATION_KEY_ERROR_CODES.keyUsed,
  });
  await expect(
    getDb().transaction((tx) =>
      createPersonalAccount(tx, `reuse${Date.now()}` as CanonicalUsername, {
        publicKey: first.publicKey,
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 409, code: IDENTITY_ERROR_CODES.rootLinkedElsewhere });
  // Nor a person's key an organization's.
  await expect(change(owner, other, 'create', admin.key)).rejects.toMatchObject({
    statusCode: 409,
  });
  // Nor a person's retired root: answered as a key another account holds.
  const retiredRoot = newKey();
  await getDb()
    .insert(personalIdentityKeyRetirements)
    .values({ userId: admin.id, publicKey: retiredRoot.publicKey });
  await expect(change(owner, other, 'create', retiredRoot)).rejects.toMatchObject({
    statusCode: 409,
    code: IDENTITY_ERROR_CODES.rootLinkedElsewhere,
  });
  const current = await getDb()
    .select({ publicKey: organizationIdentityKeys.publicKey })
    .from(organizationIdentityKeys)
    .where(and(eq(organizationIdentityKeys.accountId, org)));
  expect(current).toHaveLength(3);
});

it('a membership removed before the write refuses the write', async () => {
  const owner = await person();
  const org = await organization();
  await member(org, owner.id, 'owner');
  const pending = await change(owner, org, 'create', newKey());
  await getDb()
    .update(accountMembers)
    .set({ status: 'removed' })
    .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, owner.id)));
  await expect(pending.apply()).rejects.toMatchObject({ statusCode: 403 });
  expect(await storedKey(org)).toBeNull();
});
