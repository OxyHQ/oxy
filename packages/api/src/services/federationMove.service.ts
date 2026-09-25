/**
 * Inbound ActivityPub `Move`: a remote account moved to a LOCAL Oxy account.
 *
 * The inbox that received the Move (Mention) has already checked its shape —
 * signed by the old actor, which is both `actor` and `object` — and relays it to
 * `POST /federation/move`. Oxy owns the identity decision, and applies it only
 * when all of these hold:
 *
 *  1. `target` is the actor of an existing LOCAL account, on Oxy's own
 *     federation domain or one the relaying application is registered for;
 *  2. that account has a LIVE `activitypub` linked account (an alias)
 *     whose actor URI is the old actor — the local user proved, by OAuth, that
 *     they own the account that is moving (`docs/identity/linked-accounts.md`);
 *  3. the old actor, fetched FRESH through the SSRF-safe signed client, names
 *     the target as its `movedTo`.
 *
 * Applying it is one transaction: an audit row keyed on the activity id (the
 * idempotency key — the same Move twice applies once), inbound blocks and the
 * `canonical_user_redirects` row via the registry's verified-Move path, the
 * followers via `followCommand.moveAccountFollowers` (blocks respected), and the
 * external-identity claim marked linked. After commit, caches are invalidated
 * and the `profile` invalidation is published for BOTH accounts on
 * `oxy:user:invalidate`, which is the signal a relying app uses to re-read the
 * old account (it now resolves to the target) and reattribute its content.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { externalIdentityActors, externalIdentityClaims, externalIdentities } from '../db/schema/externalIdentities';
import { federatedAccountMoves } from '../db/schema/federatedAccountMoves';
import { userLinkedAccounts } from '../db/schema/userLinkedAccounts';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import { applyVerifiedMoveRedirect } from './externalIdentityRegistry.service';
import { federationService, isOwnFederationDomain } from './federation.service';
import { invalidateMovedFollowerCaches, moveAccountFollowers } from './followCommand.service';

export type FederationMoveRefusal =
  | 'invalid_target'
  | 'unknown_target'
  | 'alias_missing'
  | 'old_actor_unreachable'
  | 'moved_to_mismatch';

const REFUSAL_STATUS: Record<FederationMoveRefusal, number> = {
  invalid_target: 400,
  unknown_target: 404,
  alias_missing: 422,
  old_actor_unreachable: 502,
  moved_to_mismatch: 422,
};

export class FederationMoveRefused extends Error {
  readonly reason: FederationMoveRefusal;
  readonly status: number;
  constructor(reason: FederationMoveRefusal, message: string) {
    super(message);
    this.name = 'FederationMoveRefused';
    this.reason = reason;
    this.status = REFUSAL_STATUS[reason];
  }
}

export interface FederationMoveRequest {
  activityId: string;
  oldActorUri: string;
  targetActorUri: string;
  /** The relaying application (the inbox). */
  requestedByApplicationId: string | null;
  /** Federation hosts the relaying application is registered for (its redirect URIs). */
  relayHosts: ReadonlySet<string>;
}

export interface FederationMoveOutcome {
  moveId: string;
  /** True when this activity had already been applied; the counts are the first application's. */
  replayed: boolean;
  oldActorUri: string;
  targetActorUri: string;
  /** The federated shadow user of the old actor (now redirected to the target), or null if Oxy had none. */
  oldUserId: string | null;
  targetUserId: string;
  followersMoved: number;
  alreadyFollowing: number;
  skippedBlocked: number;
}

function referenceUri(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

/** `https://<host>/ap/users/<username>` on a host this Move may name, or null. */
function parseLocalActor(uri: string, relayHosts: ReadonlySet<string>): { host: string; username: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  // The username is not validated here: the account lookup below is the authority.
  const match = /^\/ap\/users\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const host = url.hostname.toLowerCase();
  const allowed =
    isOwnFederationDomain(host) ||
    [...relayHosts].some((relay) => host === relay || host.endsWith(`.${relay}`));
  return allowed ? { host, username: match[1] } : null;
}

function outcomeFromRow(row: typeof federatedAccountMoves.$inferSelect, replayed: boolean): FederationMoveOutcome {
  return {
    moveId: row.id,
    replayed,
    oldActorUri: row.oldActorUri,
    targetActorUri: row.targetActorUri,
    oldUserId: row.oldUserId,
    targetUserId: row.targetUserId,
    followersMoved: row.followersMoved,
    alreadyFollowing: row.alreadyFollowing,
    skippedBlocked: row.skippedBlocked,
  };
}

async function findRecordedMove(activityId: string) {
  const [row] = await getDb()
    .select()
    .from(federatedAccountMoves)
    .where(eq(federatedAccountMoves.activityId, activityId))
    .limit(1);
  return row ?? null;
}

/** The federated shadow user Oxy holds for `actorUri`, if any. */
async function findFederatedUser(actorUri: string): Promise<string | null> {
  const [direct] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.federationActorUri, actorUri), eq(users.type, 'federated')))
    .limit(1);
  if (direct) return direct.id;
  const [registered] = await getDb()
    .select({ id: users.id })
    .from(externalIdentityActors)
    .innerJoin(externalIdentities, eq(externalIdentities.canonicalAcct, externalIdentityActors.canonicalAcct))
    .innerJoin(users, eq(users.id, externalIdentities.userId))
    .where(and(eq(externalIdentityActors.actorUri, actorUri), eq(users.type, 'federated')))
    .limit(1);
  return registered?.id ?? null;
}

export async function applyFederationMove(request: FederationMoveRequest): Promise<FederationMoveOutcome> {
  const recorded = await findRecordedMove(request.activityId);
  if (recorded) return outcomeFromRow(recorded, true);

  const local = parseLocalActor(request.targetActorUri, request.relayHosts);
  if (!local) throw new FederationMoveRefused('invalid_target', 'target is not a local actor this application may name');

  const [target] = await getDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(sql`lower(btrim(${users.username})) = lower(${local.username})`, eq(users.type, 'local')))
    .limit(1);
  if (!target) throw new FederationMoveRefused('unknown_target', 'target names no local account');

  const [alias] = await getDb()
    .select({ id: userLinkedAccounts.id })
    .from(userLinkedAccounts)
    .where(
      and(
        eq(userLinkedAccounts.userId, target.id),
        eq(userLinkedAccounts.network, 'activitypub'),
        eq(userLinkedAccounts.actorUri, request.oldActorUri),
        isNull(userLinkedAccounts.revokedAt),
      ),
    )
    .limit(1);
  if (!alias) {
    throw new FederationMoveRefused('alias_missing', 'the target account has not linked the moving account as an alias');
  }

  const oldActor = await federationService.fetchActorDocument(request.oldActorUri);
  if (!oldActor) throw new FederationMoveRefused('old_actor_unreachable', 'the moving actor could not be fetched');
  if (referenceUri(oldActor.movedTo) !== request.targetActorUri) {
    throw new FederationMoveRefused('moved_to_mismatch', "the moving actor's movedTo does not name the target");
  }

  const oldUserId = await findFederatedUser(request.oldActorUri);

  const applied = await getDb().transaction(async (tx) => {
    // The audit row goes first: the unique activity id is what makes a
    // concurrent duplicate a no-op rather than a second application.
    const [row] = await tx
      .insert(federatedAccountMoves)
      .values({
        activityId: request.activityId,
        oldActorUri: request.oldActorUri,
        targetActorUri: request.targetActorUri,
        oldUserId,
        targetUserId: target.id,
        requestedByApplicationId: request.requestedByApplicationId,
      })
      .onConflictDoNothing({ target: federatedAccountMoves.activityId })
      .returning();
    if (!row) return null;

    let moved = { moved: [] as string[], alreadyFollowing: [] as string[], skippedBlocked: [] as string[] };
    if (oldUserId && oldUserId !== target.id) {
      await applyVerifiedMoveRedirect(tx, { fromUserId: oldUserId, toUserId: target.id });
      moved = await moveAccountFollowers(tx, { fromUserId: oldUserId, toUserId: target.id });
    }

    const [registered] = await tx
      .select({ actorUri: externalIdentityActors.actorUri })
      .from(externalIdentityActors)
      .where(eq(externalIdentityActors.actorUri, request.oldActorUri))
      .limit(1);
    if (registered) {
      const targetAcct = `${(target.username ?? local.username).toLowerCase()}@${local.host}`;
      await tx
        .insert(externalIdentityClaims)
        .values({ actorUri: request.oldActorUri, targetAcct, state: 'linked' })
        .onConflictDoUpdate({
          target: [externalIdentityClaims.actorUri, externalIdentityClaims.targetAcct],
          set: { state: 'linked', updatedAt: new Date() },
        });
    }

    const [final] = await tx
      .update(federatedAccountMoves)
      .set({
        followersMoved: moved.moved.length,
        alreadyFollowing: moved.alreadyFollowing.length,
        skippedBlocked: moved.skippedBlocked.length,
      })
      .where(eq(federatedAccountMoves.id, row.id))
      .returning();
    return { row: final, moved };
  });

  if (!applied) {
    const winner = await findRecordedMove(request.activityId);
    if (!winner) throw new Error('Move audit row vanished');
    return outcomeFromRow(winner, true);
  }

  if (oldUserId) {
    await invalidateMovedFollowerCaches({ fromUserId: oldUserId, toUserId: target.id }, applied.moved);
    userCache.invalidate(oldUserId);
  }
  userCache.invalidate(target.id);

  logger.info('[Federation] Move applied', {
    moveId: applied.row.id,
    activityId: request.activityId,
    oldActorUri: request.oldActorUri,
    targetUserId: target.id,
    oldUserId,
    requestedByApplicationId: request.requestedByApplicationId,
    followersMoved: applied.row.followersMoved,
    alreadyFollowing: applied.row.alreadyFollowing,
    skippedBlocked: applied.row.skippedBlocked,
  });

  return outcomeFromRow(applied.row, false);
}
