/**
 * Linked accounts — the records half. Providers prove; this module stores the
 * proof, enforces "one live claim per external account", and derives the
 * user's ActivityPub aliases from it.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import type { LinkedAccount, ServiceLinkedAccount } from '@oxy.so/contracts';
import { getDb, type Transaction } from '../../config/postgres';
import { linkedAccountOauthChallenges, userLinkedAccounts } from '../../db/schema/userLinkedAccounts';
import userCache from '../../utils/userCache';
import { logger } from '../../utils/logger';
import { lookupExternalIdentity } from '../externalIdentityRegistry.service';
import { sha256Hex } from './challenges';
import type { VerifiedExternalAccount } from './common';

/** A second Oxy user tried to claim an account that is already someone's live link. */
export class LinkedAccountAlreadyClaimed extends Error {
  constructor() {
    super('This account is already linked to another Oxy account');
    this.name = 'LinkedAccountAlreadyClaimed';
  }
}

const LINK_COLUMNS = {
  id: userLinkedAccounts.id,
  network: userLinkedAccounts.network,
  accountKey: userLinkedAccounts.accountKey,
  actorUri: userLinkedAccounts.actorUri,
  handle: userLinkedAccounts.handle,
  host: userLinkedAccounts.host,
  proofMethod: userLinkedAccounts.proofMethod,
  verifiedAt: userLinkedAccounts.verifiedAt,
  createdAt: userLinkedAccounts.createdAt,
};

type LinkRow = {
  id: string;
  network: LinkedAccount['network'];
  accountKey: string;
  actorUri: string;
  handle: string;
  host: string;
  proofMethod: 'oauth';
  verifiedAt: Date;
  createdAt: Date;
};

function toLinkedAccount(row: LinkRow): LinkedAccount {
  return {
    id: row.id,
    network: row.network,
    accountKey: row.accountKey,
    actorUri: row.actorUri,
    handle: row.handle,
    host: row.host,
    proofMethod: row.proofMethod,
    verifiedAt: row.verifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Publishing-relevant change → tell every consumer to re-read the user (actor, profile). */
function announceAliasChange(userId: string, network: string): void {
  if (network === 'activitypub') userCache.invalidate(userId);
}

/**
 * Record a verified link for `userId` inside `tx`. Re-linking one's own live
 * account refreshes it; an account that is another user's live link is refused.
 * Two users racing for one account meet the partial unique index, which the
 * caller maps to the same refusal. Returns the link id.
 */
async function recordLinkedAccount(tx: Transaction, userId: string, account: VerifiedExternalAccount): Promise<string> {
  const [live] = await tx
    .select({ id: userLinkedAccounts.id, userId: userLinkedAccounts.userId })
    .from(userLinkedAccounts)
    .where(
      and(
        eq(userLinkedAccounts.network, account.network),
        eq(userLinkedAccounts.accountKey, account.accountKey),
        isNull(userLinkedAccounts.revokedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (live && live.userId !== userId) throw new LinkedAccountAlreadyClaimed();
  if (live) {
    await tx
      .update(userLinkedAccounts)
      .set({ actorUri: account.actorUri, handle: account.handle, host: account.host, verifiedAt: sql`now()` })
      .where(eq(userLinkedAccounts.id, live.id));
    return live.id;
  }
  const [inserted] = await tx
    .insert(userLinkedAccounts)
    .values({
      userId,
      network: account.network,
      accountKey: account.accountKey,
      actorUri: account.actorUri,
      handle: account.handle,
      host: account.host,
      proofMethod: 'oauth',
      verifiedAt: new Date(),
    })
    .returning({ id: userLinkedAccounts.id });
  return inserted.id;
}

/** The link code is unknown, expired, burned, or already completed by nobody. */
export class LinkCodeInvalid extends Error {
  constructor() {
    super('This link code is invalid or has expired');
    this.name = 'LinkCodeInvalid';
  }
}

/** The link code belongs to a flow another user started; it is now burned. */
export class LinkCodeNotYours extends Error {
  constructor() {
    super('This link code was not issued to you');
    this.name = 'LinkCodeNotYours';
  }
}

/**
 * Turn a callback's one-time `link_code` into a link, for the signed-in user.
 *
 * Only the user who STARTED the flow may complete it. Anyone else presenting
 * the code — the victim of a flow an attacker started and sent them — burns it,
 * so it links nobody. Repeating a successful completion within the code's
 * lifetime answers the same link.
 */
export async function completeLinkedAccount(userId: string, code: string): Promise<LinkedAccount> {
  let outcome: { kind: 'invalid' } | { kind: 'refused' } | { kind: 'linked'; id: string; network: string; created: boolean };
  try {
    outcome = await getDb().transaction(async (tx) => {
      const [challenge] = await tx
        .select({
          id: linkedAccountOauthChallenges.id,
          userId: linkedAccountOauthChallenges.userId,
          status: linkedAccountOauthChallenges.status,
          network: linkedAccountOauthChallenges.network,
          accountKey: linkedAccountOauthChallenges.accountKey,
          actorUri: linkedAccountOauthChallenges.actorUri,
          handle: linkedAccountOauthChallenges.handle,
          host: linkedAccountOauthChallenges.host,
          linkedAccountId: linkedAccountOauthChallenges.linkedAccountId,
        })
        .from(linkedAccountOauthChallenges)
        .where(
          and(
            eq(linkedAccountOauthChallenges.linkCodeHash, sha256Hex(code)),
            inArray(linkedAccountOauthChallenges.status, ['verified', 'linked']),
            gt(linkedAccountOauthChallenges.expiresAt, sql`now()`),
          ),
        )
        .for('update')
        .limit(1);
      if (!challenge) return { kind: 'invalid' } as const;
      if (challenge.userId !== userId) {
        await tx
          .update(linkedAccountOauthChallenges)
          .set({ status: 'refused', linkCodeHash: null })
          .where(eq(linkedAccountOauthChallenges.id, challenge.id));
        return { kind: 'refused' } as const;
      }
      if (challenge.status === 'linked') {
        return challenge.linkedAccountId
          ? ({ kind: 'linked', id: challenge.linkedAccountId, network: challenge.network, created: false } as const)
          : ({ kind: 'invalid' } as const);
      }
      const id = await recordLinkedAccount(tx, userId, {
        network: challenge.network,
        accountKey: challenge.accountKey!,
        actorUri: challenge.actorUri!,
        handle: challenge.handle!,
        host: challenge.host!,
      });
      await tx
        .update(linkedAccountOauthChallenges)
        .set({ status: 'linked', linkedAccountId: id })
        .where(eq(linkedAccountOauthChallenges.id, challenge.id));
      return { kind: 'linked', id, network: challenge.network, created: true } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'user_linked_accounts_live_account_key')) throw new LinkedAccountAlreadyClaimed();
    throw error;
  }

  if (outcome.kind === 'invalid') throw new LinkCodeInvalid();
  if (outcome.kind === 'refused') {
    logger.warn('[LinkedAccounts] link code presented by a user who did not start the flow; burned', { userId });
    throw new LinkCodeNotYours();
  }
  if (outcome.created) {
    announceAliasChange(userId, outcome.network);
    logger.info('[LinkedAccounts] account linked', { userId, network: outcome.network, linkId: outcome.id });
  }
  const [row] = await getDb().select(LINK_COLUMNS).from(userLinkedAccounts).where(eq(userLinkedAccounts.id, outcome.id)).limit(1);
  return toLinkedAccount(row as LinkRow);
}

/** The user's live links, oldest first. */
export async function listLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
  const rows = await getDb()
    .select(LINK_COLUMNS)
    .from(userLinkedAccounts)
    .where(and(eq(userLinkedAccounts.userId, userId), isNull(userLinkedAccounts.revokedAt)))
    .orderBy(asc(userLinkedAccounts.createdAt), asc(userLinkedAccounts.id));
  return (rows as LinkRow[]).map(toLinkedAccount);
}

/**
 * The same list for a first-party service, plus the FEDERATED shadow user Oxy
 * already holds for each external account — read from the external-identity
 * registry, never written to it.
 */
export async function listLinkedAccountsForService(userId: string): Promise<ServiceLinkedAccount[]> {
  const links = await listLinkedAccounts(userId);
  return Promise.all(
    links.map(async (link) => {
      let federatedUserId: string | null = null;
      try {
        federatedUserId = await lookupExternalIdentity(link.actorUri);
        if (!federatedUserId && link.network === 'activitypub') {
          federatedUserId = await lookupExternalIdentity(link.accountKey);
        }
      } catch (error) {
        logger.warn('[LinkedAccounts] external identity lookup failed', {
          linkId: link.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { ...link, federatedUserId: federatedUserId === userId ? null : federatedUserId };
    }),
  );
}

/** Revoke one of the user's own live links. `false` when there is none by that id. */
export async function revokeLinkedAccount(userId: string, linkId: string): Promise<boolean> {
  const revoked = await getDb()
    .update(userLinkedAccounts)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userLinkedAccounts.id, linkId),
        eq(userLinkedAccounts.userId, userId),
        isNull(userLinkedAccounts.revokedAt),
      ),
    )
    .returning({ network: userLinkedAccounts.network });
  if (revoked.length === 0) return false;
  announceAliasChange(userId, revoked[0].network);
  return true;
}

/**
 * The user's ActivityPub `alsoKnownAs`: the actor URIs of their live
 * `activitypub` links, oldest link first.
 */
export async function aliasesForUser(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ actorUri: userLinkedAccounts.actorUri })
    .from(userLinkedAccounts)
    .where(
      and(
        eq(userLinkedAccounts.userId, userId),
        eq(userLinkedAccounts.network, 'activitypub'),
        isNull(userLinkedAccounts.revokedAt),
      ),
    )
    .orderBy(asc(userLinkedAccounts.createdAt), asc(userLinkedAccounts.id));
  return rows.map((row) => row.actorUri);
}
