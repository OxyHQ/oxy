/**
 * Linking Commons' root to a passkey account (ADR 0024 D8, ADR 0029 D3).
 *
 * `linkRootToAccount` is the ONE place a root is first linked, whether the
 * request carries both factors at once (`POST /auth/link`) or they arrive from
 * two devices through a link request (`routes/identityLink.ts`):
 *
 * - a root proof (`link_identity`) by the key, spending its one-use challenge;
 * - for a keyless account, a fresh assertion by one of its own passkeys over
 *   the SAME challenge, from auth.oxy.so (a bearer is a session, not that proof).
 *
 * The first link makes the account self-custodied: `users.public_key` and its
 * `identity` auth method are written, and the recovery email — with every
 * outstanding code sent to it — is deleted in the same transaction.
 *
 * A link request only relays: auth.oxy.so opens it (the challenge travels in
 * the QR, the row keeps its hash), Commons posts the signed proof with its key,
 * both devices show the code derived from that key, and auth.oxy.so completes
 * it with the passkey. First proof wins; nothing is linked until the passkey.
 */

import crypto from 'node:crypto';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { generateAuthenticationOptions, type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_AUDIENCE,
  buildIdentityLinkQrPayload,
  buildIdentityProofMessage,
  type IdentityLinkCreateResponse,
  type IdentityLinkState,
  type IdentityProof,
} from '@oxy.so/contracts';
import { getWebauthnRpId } from '../config/env';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { emailVerifications } from '../db/schema/emailVerifications';
import { identityLinkRequests } from '../db/schema/identityLinkRequests';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { webauthnCredentials } from '../db/schema/webauthnCredentials';
import { ApiError, BadRequestError, NotFoundError } from '../utils/error';
import { isAuthWebOrigin } from '../utils/origin';
import { mintIdentityProofChallenge, proofInvalid, sha256Hex, verifyIdentityProof } from './identityProof.service';
import SignatureService from './signature.service';
import { verifyFreshPasskeyAssertion } from './webauthnFreshAssertion.service';

function publicKeyMatches(candidate: string) {
  return sql`lower(btrim(${users.publicKey})) = lower(btrim(${candidate}))`;
}

function linkedElsewhere(): ApiError {
  return new ApiError(409, 'This identity is already linked to another account', IDENTITY_ERROR_CODES.rootLinkedElsewhere);
}

function freshFactorRequired(): ApiError {
  return new ApiError(401, 'Confirm with one of this account’s passkeys', IDENTITY_ERROR_CODES.freshFactorRequired);
}

function linkGone(): NotFoundError {
  return new NotFoundError('This link request expired or was cancelled');
}

export interface LinkRootInput {
  userId: string;
  /** Lowercase, uncompressed. */
  publicKey: string;
  proof: IdentityProof;
  /** Required for a keyless account: a fresh assertion over `proof.challenge`. */
  assertion?: unknown;
}

/**
 * Link `publicKey` as `userId`'s root, inside `tx`. First link only: a
 * different existing root is refused, the same root heals its method row.
 * Returns whether the account gained its root now.
 */
export async function linkRootToAccount(tx: DatabaseOrTransaction, input: LinkRootInput): Promise<{ linked: boolean }> {
  const { userId, publicKey, proof } = input;
  const [account] = await tx
    .select({ kind: users.kind, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .limit(1);
  if (!account) {
    throw new BadRequestError('User not found');
  }
  if (account.kind !== 'personal') {
    throw new ApiError(403, 'Only a personal account has a root', IDENTITY_ERROR_CODES.notPersonal);
  }
  const current = account.publicKey?.trim().toLowerCase() || null;
  if (current && current !== publicKey) {
    throw new ApiError(409, 'This account already has an identity', IDENTITY_ERROR_CODES.rootAlreadyLinked);
  }

  if (!current) {
    if (!input.assertion) throw freshFactorRequired();
    // Passkeys are asserted only on auth.oxy.so (ADR 0029 D1).
    await verifyFreshPasskeyAssertion(tx, {
      userId,
      response: input.assertion,
      challengeHex: proof.challenge,
      allowOrigin: isAuthWebOrigin,
    });
  }
  await verifyIdentityProof(tx, {
    userId,
    actor: userId,
    action: IDENTITY_PROOF_ACTIONS.link,
    rootPublicKey: publicKey,
    mintedRoot: current,
    payloadDigest: null,
    expectedRevision: null,
    proof,
  });

  if (!current) {
    const [existingUser] = await tx.select({ id: users.id }).from(users).where(publicKeyMatches(publicKey)).limit(1);
    if (existingUser && existingUser.id !== userId) throw linkedElsewhere();
    // Self-custodied from here: the recovery email, and every code sent to it,
    // goes with the custodial way back in (ADR 0029 D3).
    await tx.update(users).set({ publicKey, email: null }).where(eq(users.id, userId));
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
  }

  // The key on the account and its `user_auth_methods` row are ONE fact.
  const [existingMethod] = await tx
    .select({ id: userAuthMethods.id, methodPublicKey: userAuthMethods.methodPublicKey })
    .from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'identity')))
    .limit(1);
  if (!existingMethod) {
    await tx.insert(userAuthMethods).values({ userId, type: 'identity', methodPublicKey: publicKey });
  } else if (existingMethod.methodPublicKey?.toLowerCase() !== publicKey) {
    await tx.update(userAuthMethods).set({ methodPublicKey: publicKey }).where(eq(userAuthMethods.id, existingMethod.id));
  }
  return { linked: !current };
}

/** A live request: not expired, in one of `statuses`. */
function liveRequest(linkId: string, statuses: readonly ('pending' | 'signed')[], now: Date) {
  return and(
    eq(identityLinkRequests.linkId, linkId),
    inArray(identityLinkRequests.status, [...statuses]),
    gt(identityLinkRequests.expiresAt, now),
  );
}

/** Open a link request for a passkey account; earlier open ones are withdrawn. */
export async function createLinkRequest(userId: string, now: Date = new Date()): Promise<IdentityLinkCreateResponse> {
  const db = getDb();
  const [account] = await db.select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId)).limit(1);
  if (account?.publicKey) {
    throw new ApiError(409, 'This account already has an identity', IDENTITY_ERROR_CODES.rootAlreadyLinked);
  }
  const [passkeys] = await db
    .select({ value: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  if ((passkeys?.value ?? 0) === 0) throw freshFactorRequired();

  // Kind and root are checked (again) by the mint.
  const minted = await mintIdentityProofChallenge(userId, IDENTITY_PROOF_ACTIONS.link, now);
  const linkId = crypto.randomBytes(16).toString('hex');
  await db
    .update(identityLinkRequests)
    .set({ status: 'cancelled' })
    .where(and(eq(identityLinkRequests.userId, userId), inArray(identityLinkRequests.status, ['pending', 'signed'])));
  await db.insert(identityLinkRequests).values({
    linkId,
    userId,
    challengeHash: sha256Hex(minted.challenge),
    expiresAt: new Date(minted.expiresAt),
  });
  return {
    linkId,
    challenge: minted.challenge,
    expiresAt: minted.expiresAt,
    qrPayload: buildIdentityLinkQrPayload(linkId, minted.challenge),
  };
}

/** Where a request stands; what both devices poll. */
export async function readLinkRequest(linkId: string, now: Date = new Date()): Promise<IdentityLinkState> {
  const [row] = await getDb()
    .select({
      status: identityLinkRequests.status,
      userId: identityLinkRequests.userId,
      username: users.username,
      publicKey: identityLinkRequests.publicKey,
      expiresAt: identityLinkRequests.expiresAt,
    })
    .from(identityLinkRequests)
    .innerJoin(users, eq(users.id, identityLinkRequests.userId))
    .where(and(eq(identityLinkRequests.linkId, linkId), gt(identityLinkRequests.expiresAt, now)))
    .limit(1);
  if (!row) throw linkGone();
  return {
    status: row.status,
    userId: row.userId,
    username: row.username,
    publicKey: row.publicKey,
    audience: IDENTITY_PROOF_AUDIENCE,
    expiresAt: row.expiresAt.getTime(),
  };
}

/**
 * Commons' signed proof. Checked (signature, challenge, expiry, a key no other
 * account holds) but NOT spent: the challenge is burned only when the passkey
 * completes the link. The first proof wins.
 */
export async function submitLinkProof(
  linkId: string,
  input: { publicKey: string; proof: IdentityProof },
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ id: identityLinkRequests.id, userId: identityLinkRequests.userId, challengeHash: identityLinkRequests.challengeHash })
    .from(identityLinkRequests)
    .where(liveRequest(linkId, ['pending'], now))
    .limit(1);
  if (!row) throw linkGone();

  const { publicKey, proof } = input;
  if (!SignatureService.isValidPublicKey(publicKey)) throw proofInvalid('Not a valid identity key');
  if (sha256Hex(proof.challenge) !== row.challengeHash) throw proofInvalid();
  if (proof.expiresAt <= now.getTime()) throw proofInvalid('The identity proof expired — please try again');
  let message: string;
  try {
    message = buildIdentityProofMessage({
      action: IDENTITY_PROOF_ACTIONS.link,
      subject: row.userId,
      actor: row.userId,
      rootPublicKey: publicKey,
      payloadDigest: null,
      expectedRevision: null,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: proof.challenge,
      expiresAt: proof.expiresAt,
    });
  } catch {
    throw proofInvalid();
  }
  if (!SignatureService.verifySignature(message, proof.signature, publicKey)) throw proofInvalid('Invalid identity signature');

  const [taken] = await db.select({ id: users.id }).from(users).where(publicKeyMatches(publicKey)).limit(1);
  if (taken) throw linkedElsewhere();

  const signed = await db
    .update(identityLinkRequests)
    .set({ status: 'signed', publicKey, proof })
    .where(and(eq(identityLinkRequests.id, row.id), eq(identityLinkRequests.status, 'pending'), gt(identityLinkRequests.expiresAt, now)))
    .returning({ id: identityLinkRequests.id });
  if (signed.length === 0) throw new ApiError(409, 'This link request already has a key', 'CONFLICT');
}

/** The owner's signed request, or a 404 — never someone else's. */
async function ownedSignedRequest(db: DatabaseOrTransaction, linkId: string, userId: string, now: Date, lock = false) {
  const query = db
    .select({
      id: identityLinkRequests.id,
      challengeHash: identityLinkRequests.challengeHash,
      publicKey: identityLinkRequests.publicKey,
      proof: identityLinkRequests.proof,
    })
    .from(identityLinkRequests)
    .where(and(liveRequest(linkId, ['signed'], now), eq(identityLinkRequests.userId, userId)))
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row?.publicKey || !row.proof) throw linkGone();
  return { ...row, publicKey: row.publicKey, proof: row.proof };
}

/** WebAuthn request options over the account's passkeys whose challenge is the link's. */
export async function linkAssertionOptions(linkId: string, userId: string, challenge: string, now: Date = new Date()): Promise<unknown> {
  const db = getDb();
  const row = await ownedSignedRequest(db, linkId, userId, now);
  if (sha256Hex(challenge) !== row.challengeHash) throw proofInvalid();
  const credentials = await db
    .select({ credentialID: webauthnCredentials.credentialID, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  return generateAuthenticationOptions({
    rpID: getWebauthnRpId(),
    challenge: Buffer.from(challenge, 'hex'),
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: (credential.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: 'required',
  });
}

/** The passkey completes the link: the root, the method row, the email deleted — one transaction. */
export async function completeLinkRequest(linkId: string, userId: string, assertion: unknown, now: Date = new Date()): Promise<void> {
  await getDb().transaction(async (tx) => {
    const row = await ownedSignedRequest(tx, linkId, userId, now, true);
    await linkRootToAccount(tx, { userId, publicKey: row.publicKey, proof: row.proof, assertion });
    await tx.update(identityLinkRequests).set({ status: 'completed' }).where(eq(identityLinkRequests.id, row.id));
  });
}

/** Withdraw an open request of the owner's. */
export async function cancelLinkRequest(linkId: string, userId: string): Promise<void> {
  await getDb()
    .update(identityLinkRequests)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(identityLinkRequests.linkId, linkId),
        eq(identityLinkRequests.userId, userId),
        inArray(identityLinkRequests.status, ['pending', 'signed']),
      ),
    );
}
