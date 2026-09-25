/**
 * Linked accounts — the records half. Providers prove; this module stores the
 * proof, enforces "one live claim per external account", and derives the
 * user's ActivityPub aliases from it.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import type { LinkedAccount, ServiceLinkedAccount } from '@oxy.so/contracts';
import { getDb } from '../../config/postgres';
import { userLinkedAccounts } from '../../db/schema/userLinkedAccounts';
import userCache from '../../utils/userCache';
import { logger } from '../../utils/logger';
import { lookupExternalIdentity } from '../externalIdentityRegistry.service';
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
  useAsAlias: userLinkedAccounts.useAsAlias,
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
  useAsAlias: boolean;
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
    useAsAlias: row.useAsAlias,
    verifiedAt: row.verifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Publishing-relevant change → tell every consumer to re-read the user (actor, profile). */
function announceAliasChange(userId: string, network: string): void {
  if (network === 'activitypub') userCache.invalidate(userId);
}

/**
 * Record a verified link for `userId`. Re-linking one's own live account
 * refreshes it; an account that is another user's live link is refused.
 * Returns the link id.
 */
export async function recordLinkedAccount(userId: string, account: VerifiedExternalAccount): Promise<string> {
  let id: string;
  try {
    id = await getDb().transaction(async (tx) => {
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
          useAsAlias: account.network === 'activitypub',
        })
        .returning({ id: userLinkedAccounts.id });
      return inserted.id;
    });
  } catch (error) {
    // Two users completing the same account at once: the partial unique index
    // decides, and the loser is told exactly what the lock would have told it.
    if (isUniqueViolation(error, 'user_linked_accounts_live_account_key')) throw new LinkedAccountAlreadyClaimed();
    throw error;
  }
  announceAliasChange(userId, account.network);
  logger.info('[LinkedAccounts] account linked', { userId, network: account.network, linkId: id });
  return id;
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
 * `activitypub` links marked as aliases, oldest link first.
 */
export async function aliasesForUser(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ actorUri: userLinkedAccounts.actorUri })
    .from(userLinkedAccounts)
    .where(
      and(
        eq(userLinkedAccounts.userId, userId),
        eq(userLinkedAccounts.network, 'activitypub'),
        eq(userLinkedAccounts.useAsAlias, true),
        isNull(userLinkedAccounts.revokedAt),
      ),
    )
    .orderBy(asc(userLinkedAccounts.createdAt), asc(userLinkedAccounts.id));
  return rows.map((row) => row.actorUri);
}
