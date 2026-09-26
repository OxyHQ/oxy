/**
 * Linking Commons' root to an account (ADR 0024 D8, ADR 0029 D3, ADR 0030).
 *
 * `linkRootToAccount` is the ONE place a root is first linked, whether the
 * request carries both factors at once (`POST /auth/link`) or they arrive from
 * two devices through a link request (`routes/identityLink.ts`):
 *
 * - a root proof (`link_identity`) by the key, spending its one-use challenge;
 * - for a keyless account, a fresh confirmation by the person, not only their
 *   session: a code just sent to the account's email (plus its authenticator
 *   code when it has one, `reauth.service.ts`).
 *
 * The first link makes the account self-custodied: `users.public_key` and its
 * `identity` auth method are written, and the account's email — with every
 * outstanding code sent to it — is deleted in the same transaction.
 *
 * A link request only relays: the signed-in app opens it (the challenge travels in
 * the QR, the row keeps its hash), Commons posts the signed proof with its key,
 * both devices show the code derived from that key, and the account completes
 * it with the email code. First proof wins; nothing is linked
 * until that confirmation.
 */

import crypto from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_AUDIENCE,
  buildIdentityLinkQrPayload,
  buildIdentityProofMessage,
  type EmailReauthProof,
  type IdentityLinkCreateResponse,
  type IdentityLinkState,
  type IdentityProof,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { emailVerifications } from '../db/schema/emailVerifications';
import { userPasswords } from '../db/schema/userPasswords';
import { userTotp, userTotpBackupCodes } from '../db/schema/userTotp';
import { identityLinkRequests } from '../db/schema/identityLinkRequests';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { ApiError, BadRequestError, NotFoundError } from '../utils/error';
import { mintIdentityProofChallenge, proofInvalid, sha256Hex, verifyIdentityProof } from './identityProof.service';
import SignatureService from './signature.service';
import { verifyEmailReauth } from './reauth.service';

function publicKeyMatches(candidate: string) {
  return sql`lower(btrim(${users.publicKey})) = lower(btrim(${candidate}))`;
}

function linkedElsewhere(): ApiError {
  return new ApiError(409, 'This identity is already linked to another account', IDENTITY_ERROR_CODES.rootLinkedElsewhere);
}

function freshFactorRequired(): ApiError {
  return new ApiError(401, 'Confirm with a code sent to this account’s email', IDENTITY_ERROR_CODES.freshFactorRequired);
}

function linkGone(): NotFoundError {
  return new NotFoundError('This link request expired or was cancelled');
}

export interface LinkRootInput {
  userId: string;
  /** Lowercase, uncompressed. */
  publicKey: string;
  proof: IdentityProof;
  /**
   * A keyless account's confirmation: the email re-verification (plus the
   * authenticator), ALREADY checked by the caller ({@link completeLinkRequest}
   * runs `verifyEmailReauth` first). Only that caller sets it.
   */
  emailReauthVerified?: true;
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

  if (!current && !input.emailReauthVerified) throw freshFactorRequired();
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
    // …and so does every other way in Oxy checked for it: a Commons account
    // signs in with Commons, so its password and authenticator go too, in
    // the same transaction.
    await tx.delete(userPasswords).where(eq(userPasswords.userId, userId));
    await tx.delete(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
    await tx.delete(userTotp).where(eq(userTotp.userId, userId));
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

/** Open a link request for an account without a key; earlier open ones are withdrawn. */
export async function createLinkRequest(userId: string, now: Date = new Date()): Promise<IdentityLinkCreateResponse> {
  const db = getDb();
  const [account] = await db
    .select({ publicKey: users.publicKey, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (account?.publicKey) {
    throw new ApiError(409, 'This account already has an identity', IDENTITY_ERROR_CODES.rootAlreadyLinked);
  }
  // The link is confirmed with a code sent to the email, so the account needs one.
  if (!account?.email) throw freshFactorRequired();

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
 * account holds) but NOT spent: the challenge is burned only when the email
 * code completes the link. The first proof wins.
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

/**
 * The account's confirmation completes the link: the root, the method row, the
 * email deleted — one transaction. An email confirmation is checked (and its
 * code spent) first, against a request that is still the owner's and signed.
 * Returns the email the account HAD, for the notice that it is gone.
 */
export async function completeLinkRequest(
  linkId: string,
  userId: string,
  confirmation: { reauth: EmailReauthProof },
  now: Date = new Date(),
): Promise<{ formerEmail: string | null; username: string | null }> {
  const db = getDb();
  await ownedSignedRequest(db, linkId, userId, now);
  await verifyEmailReauth(userId, confirmation.reauth, 'link_commons', now);
  const [before] = await db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  await db.transaction(async (tx) => {
    const row = await ownedSignedRequest(tx, linkId, userId, now, true);
    await linkRootToAccount(tx, {
      userId,
      publicKey: row.publicKey,
      proof: row.proof,
      emailReauthVerified: true,
    });
    await tx.update(identityLinkRequests).set({ status: 'completed' }).where(eq(identityLinkRequests.id, row.id));
  });
  return { formerEmail: before?.email?.trim().toLowerCase() || null, username: before?.username ?? null };
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
