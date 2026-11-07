/**
 * An organization's identity key (ADR 0061): its DID `#key-1`, the key Peable
 * derives its FairCoin receive addresses from. This module is the ONE writer of
 * an organization's `users.public_key` and of `organization_identity_keys`.
 *
 * - Only a claimed, active organization without a closure fence (D1).
 * - Only a person whose effective role over it is `owner` or `admin`, read
 *   under lock in the writing transaction (D3; ADR 0056: the role, never the
 *   member's permission deltas).
 * - One challenge (`identity_proof_challenges`, the ADR 0024 D7 format) and
 *   three signatures over the same claims: the actor's OWN root, the new key,
 *   and — to replace — the current key when the device has it (D4, D7).
 * - The key signs nobody in: no `identity` auth method is written, and every
 *   key sign-in refuses a non-personal account (D2).
 *
 * The private key and its phrase never reach the server; they are created and
 * held in Commons (D5, D6).
 */

import crypto from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_AUDIENCE,
  IDENTITY_PROOF_CHALLENGE_TTL_MS,
  IDENTITY_PROOF_VERSION,
  ORGANIZATION_KEY_ERROR_CODES,
  ORGANIZATION_KEY_PROOF_ACTIONS,
  buildIdentityProofMessage,
  organizationKeyPayload,
  organizationKeyProofClaims,
  type OrganizationIdentityKeyState,
  type OrganizationKeyApplyRequest,
  type OrganizationKeyChallenge,
  type OrganizationKeyChallengeRequest,
  type OrganizationKeyOperation,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { identityProofChallenges } from '../db/schema/identityProofChallenges';
import { organizationIdentityKeys } from '../db/schema/organizationIdentityKeys';
import { organizationProfiles } from '../db/schema/organizationProfiles';
import { securityActivities } from '../db/schema/securityActivities';
import { sessions } from '../db/schema/sessions';
import { users } from '../db/schema/users';
import { ApiError, BadRequestError } from '../utils/error';
import { readLockedEffectiveMembership, resolveEffectiveMembership } from './account.service';
import { accountMembers } from '../db/schema/accountMembers';
import { userAncestors } from '../db/schema/userAncestors';
import {
  digestIdentityPayload,
  proofInvalid,
  sha256Hex,
  verifyIdentityProof,
} from './identityProof.service';
import {
  lockIdentityKeys,
  organizationKeyEverUsed,
  personalKeyEverRetired,
} from './organizationKeyHistory';
import SignatureService from './signature.service';

/** The roles that may hold and change an organization's key (ADR 0061 D3). */
const KEY_GOVERNING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

function forbidden(): ApiError {
  return new ApiError(
    403,
    'Only an owner or admin of this organization can manage its key',
    ORGANIZATION_KEY_ERROR_CODES.forbidden,
  );
}

function sessionInvalid(): ApiError {
  return new ApiError(401, 'Session required', 'INVALID_SESSION');
}

function lowerKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/** The key as the API stores it, or a 400. */
function canonicalKey(publicKey: string): string {
  try {
    return SignatureService.canonicalizePublicKey(publicKey).toLowerCase();
  } catch {
    throw new BadRequestError('Not a valid identity key');
  }
}

interface KeyContext {
  actorId: string;
  /** The actor's own root, or `null` (only a read may proceed without one). */
  actorPublicKey: string | null;
  /** The organization's key now, canonical, or `null`. */
  currentPublicKey: string | null;
}

/**
 * Who is asking, and may they. `lock` (a write) takes the session row, both
 * account rows and the membership rows FOR UPDATE, so a sign-out, a role change
 * or a concurrent key change cannot interleave the authorization.
 */
async function keyContext(
  db: DatabaseOrTransaction,
  sessionId: string,
  accountId: string,
  lock: boolean,
): Promise<KeyContext> {
  const sessionQuery = db
    .select({ userId: sessions.userId, operatedByUserId: sessions.operatedByUserId })
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionId, sessionId),
        eq(sessions.isActive, true),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  const [session] = lock ? await sessionQuery.for('update') : await sessionQuery;
  if (!session) throw sessionInvalid();
  // The person, also when the session acts as an account (ADR 0001).
  const actorId = session.operatedByUserId ?? session.userId;
  if (actorId === accountId) throw forbidden();

  if (lock) {
    await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [actorId, accountId]))
      .orderBy(asc(users.id))
      .for('update');
  }
  const rows = await db
    .select({
      id: users.id,
      kind: users.kind,
      status: users.accountStatus,
      publicKey: users.publicKey,
      fence: accountClosureFences.accountId,
      claimStatus: organizationProfiles.claimStatus,
      directoryStatus: organizationProfiles.status,
    })
    .from(users)
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .leftJoin(organizationProfiles, eq(organizationProfiles.accountId, users.id))
    .where(inArray(users.id, [actorId, accountId]));
  const actor = rows.find((row) => row.id === actorId);
  const target = rows.find((row) => row.id === accountId);
  if (actor?.kind !== 'personal' || actor.status !== 'active' || actor.fence) throw forbidden();
  if (
    target?.kind !== 'organization' ||
    target.status !== 'active' ||
    target.fence ||
    target.claimStatus !== 'claimed' ||
    target.directoryStatus !== 'active'
  )
    throw forbidden();

  const membership = lock
    ? await readLockedEffectiveMembership(db, actorId, accountId)
    : await readEffectiveMembership(db, actorId, accountId);
  if (!membership || !KEY_GOVERNING_ROLES.has(membership.row.role)) throw forbidden();

  return {
    actorId,
    actorPublicKey: lowerKey(actor.publicKey),
    currentPublicKey: lowerKey(target.publicKey),
  };
}

/** The same membership answer without locks, for a read. */
async function readEffectiveMembership(
  db: DatabaseOrTransaction,
  actorId: string,
  accountId: string,
) {
  const ancestors = await db
    .select({ ancestorId: userAncestors.ancestorId })
    .from(userAncestors)
    .where(eq(userAncestors.userId, accountId))
    .orderBy(asc(userAncestors.depth));
  const path = ancestors.map((a) => a.ancestorId);
  const members = await db
    .select()
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.memberUserId, actorId),
        eq(accountMembers.status, 'active'),
        inArray(accountMembers.accountId, [accountId, ...path]),
      ),
    )
    .orderBy(asc(accountMembers.id));
  return resolveEffectiveMembership(members, accountId, path);
}

/** The operation must fit the organization's state, and the key must be new to every account. */
async function checkOperation(
  db: DatabaseOrTransaction,
  context: KeyContext,
  operation: OrganizationKeyOperation,
  publicKey: string,
): Promise<void> {
  if (operation === 'create' && context.currentPublicKey) {
    throw new ApiError(
      409,
      'This organization already has a key',
      IDENTITY_ERROR_CODES.rootAlreadyLinked,
    );
  }
  if (operation === 'replace' && !context.currentPublicKey) {
    throw new ApiError(409, 'This organization has no key yet', ORGANIZATION_KEY_ERROR_CODES.noKey);
  }
  if (!context.actorPublicKey) {
    throw new ApiError(
      403,
      'Sign in with Commons to manage the organization’s key',
      ORGANIZATION_KEY_ERROR_CODES.actorRootRequired,
    );
  }
  if (publicKey === context.currentPublicKey || publicKey === context.actorPublicKey) {
    throw new ApiError(409, 'This key was already used', ORGANIZATION_KEY_ERROR_CODES.keyUsed);
  }
  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.publicKey})) = ${publicKey}`)
    .limit(1);
  // A person's retired root was a person's: answered as one linked elsewhere.
  if (holder || (await personalKeyEverRetired(db, publicKey))) {
    throw new ApiError(
      409,
      'This identity is already linked to another account',
      IDENTITY_ERROR_CODES.rootLinkedElsewhere,
    );
  }
  if (await organizationKeyEverUsed(db, publicKey)) {
    throw new ApiError(409, 'This key was already used', ORGANIZATION_KEY_ERROR_CODES.keyUsed);
  }
}

function payloadDigestFor(
  accountId: string,
  operation: OrganizationKeyOperation,
  publicKey: string,
  previousPublicKey: string | null,
): string {
  return digestIdentityPayload(
    organizationKeyPayload({ operation, accountId, publicKey, previousPublicKey }),
  );
}

async function readState(
  db: DatabaseOrTransaction,
  accountId: string,
  currentPublicKey: string | null,
): Promise<OrganizationIdentityKeyState> {
  const keys = await db
    .select({
      publicKey: organizationIdentityKeys.publicKey,
      method: organizationIdentityKeys.method,
      linkedByUserId: organizationIdentityKeys.linkedByUserId,
      previousKeyProven: organizationIdentityKeys.previousKeyProven,
      linkedAt: organizationIdentityKeys.linkedAt,
      retiredAt: organizationIdentityKeys.retiredAt,
    })
    .from(organizationIdentityKeys)
    .where(eq(organizationIdentityKeys.accountId, accountId))
    .orderBy(asc(organizationIdentityKeys.linkedAt), asc(organizationIdentityKeys.id));
  return {
    accountId,
    publicKey: currentPublicKey,
    keys: keys.map((key) => ({
      ...key,
      linkedAt: key.linkedAt.toISOString(),
      retiredAt: key.retiredAt?.toISOString() ?? null,
    })),
  };
}

/** `GET /accounts/:id/identity-key` — owners and admins only. */
export async function readOrganizationIdentityKey(
  sessionId: string,
  accountId: string,
): Promise<OrganizationIdentityKeyState> {
  const db = getDb();
  const context = await keyContext(db, sessionId, accountId, false);
  return readState(db, accountId, context.currentPublicKey);
}

/** `POST /accounts/:id/identity-key/challenge` */
export async function requestOrganizationKeyChallenge(
  sessionId: string,
  accountId: string,
  request: OrganizationKeyChallengeRequest,
  now: Date = new Date(),
): Promise<OrganizationKeyChallenge> {
  const db = getDb();
  const context = await keyContext(db, sessionId, accountId, false);
  const publicKey = canonicalKey(request.publicKey);
  await checkOperation(db, context, request.operation, publicKey);
  const actorPublicKey = context.actorPublicKey;
  if (!actorPublicKey) throw forbidden();

  const challenge = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + IDENTITY_PROOF_CHALLENGE_TTL_MS);
  const action = ORGANIZATION_KEY_PROOF_ACTIONS[request.operation];
  await db.insert(identityProofChallenges).values({
    userId: accountId,
    action,
    challengeHash: sha256Hex(challenge),
    rootPublicKey: context.currentPublicKey,
    expiresAt,
  });
  return {
    operation: request.operation,
    action,
    accountId,
    actorId: context.actorId,
    actorPublicKey,
    publicKey,
    previousPublicKey: context.currentPublicKey,
    payloadDigest: payloadDigestFor(
      accountId,
      request.operation,
      publicKey,
      context.currentPublicKey,
    ),
    audience: IDENTITY_PROOF_AUDIENCE,
    challenge,
    expiresAt: expiresAt.getTime(),
  };
}

function signedBy(message: string, signature: string, publicKey: string): boolean {
  return SignatureService.verifySignature(message, signature, publicKey);
}

/**
 * `POST /accounts/:id/identity-key` — apply one change. The organization's
 * key, its history, the challenge burn and the audit row commit together.
 */
export async function applyOrganizationKey(
  sessionId: string,
  accountId: string,
  request: OrganizationKeyApplyRequest,
  now: Date = new Date(),
): Promise<OrganizationIdentityKeyState> {
  return getDb().transaction(async (tx: Transaction) => {
    const context = await keyContext(tx, sessionId, accountId, true);
    const publicKey = canonicalKey(request.publicKey);
    // Under the key's lock (R7, info): no personal writer can make it a root or
    // a retired root between the checks and the insert.
    await lockIdentityKeys(tx, publicKey);
    await checkOperation(tx, context, request.operation, publicKey);
    const actorPublicKey = context.actorPublicKey;
    if (!actorPublicKey) throw forbidden();
    const previousPublicKey = context.currentPublicKey;
    const action = ORGANIZATION_KEY_PROOF_ACTIONS[request.operation];
    const payloadDigest = payloadDigestFor(
      accountId,
      request.operation,
      publicKey,
      previousPublicKey,
    );
    const challenge: OrganizationKeyChallenge = {
      operation: request.operation,
      action,
      accountId,
      actorId: context.actorId,
      actorPublicKey,
      publicKey,
      previousPublicKey,
      payloadDigest,
      audience: IDENTITY_PROOF_AUDIENCE,
      challenge: request.challenge,
      expiresAt: request.expiresAt,
    };
    const messageFor = (signer: string): string => {
      try {
        return buildIdentityProofMessage(organizationKeyProofClaims(challenge, signer));
      } catch {
        throw proofInvalid();
      }
    };

    // Possession of the new key, and of the current one when it is offered.
    if (!signedBy(messageFor(publicKey), request.keySignature, publicKey)) {
      throw proofInvalid('The new key did not sign this change');
    }
    let previousKeyProven = false;
    if (request.previousKeySignature !== undefined) {
      if (!previousPublicKey) throw new BadRequestError('There is no current key to sign with');
      if (!signedBy(messageFor(previousPublicKey), request.previousKeySignature, previousPublicKey))
        throw proofInvalid('The current key did not sign this change');
      previousKeyProven = true;
    }
    // The person's own root, and the one-use challenge it spends. A rollback
    // below un-burns it together with the write it authorized.
    await verifyIdentityProof(
      tx,
      {
        userId: accountId,
        actor: context.actorId,
        action,
        rootPublicKey: actorPublicKey,
        mintedRoot: previousPublicKey,
        payloadDigest,
        expectedRevision: null,
        proof: {
          v: IDENTITY_PROOF_VERSION,
          challenge: request.challenge,
          expiresAt: request.expiresAt,
          signature: request.actorSignature,
        },
      },
      now,
    );

    await tx
      .update(users)
      .set({ publicKey })
      .where(
        and(
          eq(users.id, accountId),
          previousPublicKey
            ? sql`lower(btrim(${users.publicKey})) = ${previousPublicKey}`
            : isNull(users.publicKey),
        ),
      );
    if (previousPublicKey) {
      const retired = await tx
        .update(organizationIdentityKeys)
        .set({ retiredAt: now })
        .where(
          and(
            eq(organizationIdentityKeys.accountId, accountId),
            isNull(organizationIdentityKeys.retiredAt),
          ),
        )
        .returning({ id: organizationIdentityKeys.id });
      // A key set before this table existed still becomes a tombstone.
      if (retired.length === 0) {
        await tx.insert(organizationIdentityKeys).values({
          accountId,
          publicKey: previousPublicKey,
          method: 'create',
          linkedByUserId: null,
          linkedAt: now,
          retiredAt: now,
        });
      }
    }
    await tx.insert(organizationIdentityKeys).values({
      accountId,
      publicKey,
      method: request.operation,
      linkedByUserId: context.actorId,
      previousKeyProven,
      linkedAt: now,
    });
    await tx.insert(securityActivities).values({
      userId: accountId,
      eventType: 'security_settings_changed',
      severity: 'high',
      eventDescription:
        request.operation === 'create'
          ? 'Organization identity key created'
          : 'Organization identity key replaced',
      metadata: {
        action: `organization_key.${request.operation}`,
        actorAccountId: context.actorId,
        effectiveAccountId: accountId,
        publicKey,
        previousPublicKey,
        previousKeyProven,
      },
    });
    return readState(tx, accountId, publicKey);
  });
}
