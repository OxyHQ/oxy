/**
 * Blocked-domain purge — the Oxy-platform half of "block an instance".
 *
 * When an app blocks a fediverse instance it stops federating with it and
 * deletes what it mirrored. But an ingested actor also leaves a trail on the Oxy
 * PLATFORM: a `type:'federated'` user row (minted by `PUT /users/resolve` or by
 * `federationService.resolveAndUpsert`), the avatar Oxy downloaded for it, and
 * the post media the app mirrored into Oxy storage. None of that is reachable
 * from the app's own database, so blocking used to leave it behind forever.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is NOT a blocklist, and Oxy must never grow one. The set of blocked domains
 * is a MODERATION POLICY, and it belongs to the app that federates — committed,
 * reviewed and published there. Oxy is a multi-tenant platform underneath
 * several apps; a blocklist stored here would either be a stale replica of that
 * policy (two copies that disagree exactly when it matters, which is the moment
 * something irreversible fires) or, worse, would make one app's moderation
 * decisions binding on every other app. So this module accepts a domain from an
 * authenticated caller and reports or removes what Oxy holds for it. It never
 * decides WHETHER a domain is blocked, and it has no state that can be wrong:
 * the only way for the two sides to be out of step is work not yet done, which
 * a retry fixes. That is why every operation here is idempotent and resumable
 * rather than transactional.
 *
 * WHOSE DATA GETS DELETED
 * -----------------------
 * An Oxy federated user row is shared platform state. It is keyed on the
 * globally-unique `federation_actor_uri`, so if two apps ever ingest the same
 * remote actor they get the SAME row — and deleting it because one app blocked
 * the instance would destroy data the other app legitimately holds.
 *
 *   - Files are deleted only when their `metadata.serviceAppId` is the
 *     AUTHENTICATED caller's application id (resolved from the service
 *     credential — never a value the caller supplies).
 *   - Federated actor rows are retained. Oxy does not currently keep a complete
 *     per-application reference ledger for these globally shared rows, so the
 *     absence of another app's file is not proof that no other app references
 *     the actor. Hard deletion would cross the caller's authorization boundary.
 *
 * MATCHING
 * --------
 * A purge must match EXACTLY the hosts the federation engine refuses — never
 * more. Over-matching deletes content for a domain that was never blocked, and
 * that is irreversible. So host comparison goes through
 * {@link canonicalFederationHost} / {@link isSameFederationHost} from
 * `@oxyhq/federation` — the same functions `createDomainPolicy` is built from,
 * not a local copy that agrees today. Consequences, all deliberate:
 *
 *   - `www.` is stripped on both sides. Oxy's resolve paths store
 *     `federation_domain` lowercased but do NOT strip `www.`, so stored
 *     `www.example.com` rows exist and a naive equality query would miss them.
 *   - Subdomains do NOT match. `isBlockedDomain` is exact canonical-host set
 *     membership, so `sub.example.com` is untouched when `example.com` is
 *     blocked — the engine still federates with it.
 *   - A trailing dot does not match, matching the engine.
 *
 * The candidate query is an indexed `in (…)` over the two spellings that can
 * canonicalise to the target, and then EVERY candidate is re-verified with
 * `isSameFederationHost` before it is touched. A row that fails re-verification
 * is skipped and counted. So a query that somehow widens can only ever
 * under-delete — recoverable — and never over-delete.
 */

import { and, asc, count, eq, gt, inArray, ne } from 'drizzle-orm';
import { canonicalFederationHost, isSameFederationHost } from '@oxyhq/federation';
import { getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { logger } from '../../utils/logger';
import userCache from '../../utils/userCache';
import { assetService } from '../assetServiceSingleton';
import { isOwnFederationDomain } from '../federation.service';

const COMPONENT = 'blockedDomainPurge';

/**
 * Default number of actors processed per call. Each actor costs a small number
 * of queries plus one S3 delete per file, so an unbounded run would hold a
 * request (or an ECS task) open for an arbitrary time on a large instance.
 * Callers loop until {@link BlockedDomainPurgeResult.done} is true, passing
 * {@link BlockedDomainPurgeResult.nextCursor} as `afterId` on each subsequent
 * call. Do NOT loop on {@link BlockedDomainPurgeResult.remaining} — retained
 * rows keep matching forever.
 */
export const DEFAULT_PURGE_LIMIT = 200;

/** Hard ceiling on `limit`, so a caller cannot ask for an unbounded run. */
export const MAX_PURGE_LIMIT = 1000;

export interface BlockedDomainPurgeOptions {
  /** Domain as the caller spells it; canonicalised before anything is read. */
  domain: string;
  /**
   * The application id resolved from the caller's service credential. NEVER a
   * client-supplied value — it decides whose files may be deleted.
   */
  callerAppId: string;
  /** When true (the default) compute the plan and apply nothing. */
  dryRun: boolean;
  /** Max actors to process this call. Clamped to {@link MAX_PURGE_LIMIT}. */
  limit: number;
  /**
   * Continuation cursor: process only actors whose `id` sorts after this one.
   * Echo {@link BlockedDomainPurgeResult.nextCursor} back to continue.
   *
   * Progress CANNOT be left to "deleted rows stop matching", because retained
   * rows (shared with another application) and dry runs both leave every row in
   * place. Either would re-fetch the same head of the batch on every call and
   * never advance — a livelock, and on a dry run the caller would loop forever
   * over the first `limit` actors while believing it was making progress. An
   * `id` cursor advances monotonically whatever each actor's outcome is.
   */
  afterId?: string;
}

/** Why a federated user row survived a purge that reached it. */
export interface RetainedActor {
  oxyUserId: string;
  username: string;
  /** Application ids, other than the caller, still holding files for this row. */
  referencedByAppIds: string[];
  /** Why the shared actor row could not safely be hard-deleted. */
  retentionReason: 'other_application_files' | 'application_references_unknown';
}

export interface BlockedDomainPurgeResult {
  /** The domain exactly as the caller sent it. */
  requestedDomain: string;
  /** The canonical host it was compared as. */
  canonicalDomain: string;
  dryRun: boolean;
  /** Federated user rows matched (before the batch limit). */
  actorsMatched: number;
  /** Actors this call processed. */
  actorsProcessed: number;
  /** Actors whose user row was (or would be) hard-deleted. */
  actorsDeleted: number;
  /** Actors archived and kept because another app still holds their data. */
  actorsRetained: RetainedActor[];
  /** Files owned by the caller's application that were (or would be) deleted. */
  filesDeleted: number;
  /** Bytes those files occupied. */
  bytesDeleted: number;
  /** Avatars Oxy fetched itself, deleted alongside a deleted row. */
  avatarsDeleted: number;
  /** Follow-graph edges removed by the actor teardown. */
  followEdgesRemoved: number;
  /**
   * Inbound follows from LOCAL Oxy users among the processed actors. A non-zero
   * value means the purge is user-visible: a real person loses a follow.
   */
  localFollowersAffected: number;
  /**
   * Candidates fetched by the indexed query that FAILED `isSameFederationHost`
   * re-verification and were skipped. Should be 0; a non-zero value means the
   * candidate query is wider than the canonical rule and wants investigating.
   */
  candidatesRejected: number;
  /**
   * Actors still matching the domain after this call. Reported for visibility,
   * NOT as the loop condition — retained rows keep matching forever, so a
   * caller that looped on `remaining > 0` would never stop.
   */
  remaining: number;
  /**
   * Pass as `afterId` on the next call. `null` when the scan reached the end.
   */
  nextCursor: string | null;
  /** True when this pass reached the end of the scan. THE loop condition. */
  done: boolean;
}

/** Raised when the requested domain must never be purged. */
export class UnpurgeableDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpurgeableDomainError';
  }
}

/**
 * The two stored spellings that can canonicalise to `canonical`.
 *
 * `canonicalFederationHost` only trims, lowercases and strips a leading `www.`,
 * and stored `federation_domain` values are already written trimmed+lowercased,
 * so `{canonical, 'www.'+canonical}` is exhaustive. Both are exact values
 * against the partial `users_federation_domain_idx` — no `like`, no sequential
 * scan. If a stored value ever escaped that normalisation the query would MISS
 * it (an under-delete, the safe direction) rather than over-reach.
 */
function candidateDomainSpellings(canonical: string): string[] {
  return [canonical, `www.${canonical}`];
}

/**
 * Files belonging to a federated actor, split by who owns them.
 *
 * `callerOwned` are the caller application's uploads — the only files this
 * purge may delete on that application's authority. `unattributed` are the
 * avatars Oxy downloaded itself (`source:'federation'`, no `serviceAppId`);
 * they belong to the user row, so they go only when the row itself goes.
 * `otherAppIds` is what makes the row shared: any other application id found
 * here blocks deletion of the row.
 *
 * TOMBSTONES ARE NOT HELD DATA. `assetService.deleteFile` marks a row
 * `status:'deleted'` rather than removing it, so a purge that counted every row
 * would (a) re-delete and re-count the same file on every later pass over a
 * RETAINED actor — whose row survives, and with it its tombstones — and (b) keep
 * that actor retained forever on the strength of another app's already-deleted
 * file. Mongo's `File.find({ownerUserId})` carried no status filter; here it is
 * what makes a repeat pass over a retained actor a genuine no-op.
 */
async function classifyActorFiles(
  oxyUserId: string,
  callerAppId: string,
): Promise<{
  callerOwned: Array<{ id: string; size: number }>;
  unattributed: Array<{ id: string; size: number }>;
  otherAppIds: string[];
}> {
  const rows = await getDb()
    .select({ id: files.id, size: files.size, metadata: files.metadata })
    .from(files)
    .where(and(eq(files.ownerUserId, oxyUserId), ne(files.status, 'deleted')));

  const callerOwned: Array<{ id: string; size: number }> = [];
  const unattributed: Array<{ id: string; size: number }> = [];
  const otherAppIds = new Set<string>();

  for (const file of rows) {
    const metadata = file.metadata ?? {};
    const serviceAppId = metadata.serviceAppId;
    const entry = { id: file.id, size: typeof file.size === 'number' ? file.size : 0 };

    if (typeof serviceAppId === 'string' && serviceAppId.length > 0) {
      if (serviceAppId === callerAppId) {
        callerOwned.push(entry);
      } else {
        otherAppIds.add(serviceAppId);
      }
      continue;
    }

    // No owning application, so no app can claim it and no app is blocked by
    // it. Oxy's own federation avatar fetch (`source:'federation'`, no
    // `serviceAppId`) is the case that actually occurs; anything else
    // unattributed is treated identically, because a file nobody claims is
    // still tied to the row and must not outlive it as an orphan.
    unattributed.push(entry);
  }

  return { callerOwned, unattributed, otherAppIds: [...otherAppIds].sort() };
}

/**
 * Delete one file through the asset service so S3 objects, variants and the
 * backfilled public copy all go with it. `force` is required because federation
 * media may carry link rows; the row is being removed regardless.
 *
 * A single file failing must not abandon the rest of the purge — the run is
 * resumable, so the right behaviour is to log the specific file and carry on,
 * leaving it to be retried on the next pass. Returns whether it succeeded so
 * the caller only counts real deletions.
 */
async function deleteFileBestEffort(fileId: string, context: Record<string, unknown>): Promise<boolean> {
  try {
    await assetService.deleteFile(fileId, true);
    return true;
  } catch (error) {
    logger.warn('blockedDomainPurge: file delete failed, will retry on next pass', {
      component: COMPONENT,
      fileId,
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Plan and (unless `dryRun`) apply a blocked-domain purge for ONE domain.
 *
 * The plan is computed identically on both paths — `dryRun` gates only whether
 * it is applied — so the numbers an operator approves are the numbers that
 * execute.
 */
export async function purgeBlockedDomain(
  options: BlockedDomainPurgeOptions,
): Promise<BlockedDomainPurgeResult> {
  const { domain, callerAppId, dryRun } = options;
  const limit = Math.min(Math.max(1, options.limit), MAX_PURGE_LIMIT);

  const canonicalDomain = canonicalFederationHost(domain);
  if (canonicalDomain.length === 0) {
    throw new UnpurgeableDomainError('domain is empty after canonicalisation');
  }

  // A blank or absent caller id would make `serviceAppId === callerAppId` match
  // nothing, so the purge would silently delete no files while still deleting
  // rows. Refuse rather than run a half-purge.
  if (callerAppId.length === 0) {
    throw new UnpurgeableDomainError('caller application id is required');
  }

  // HARD GUARD: our own apex is a federation domain to the rest of the network,
  // but its handles denote LOCAL users. Purging it would tear down real
  // accounts' graphs. Refuse before reading anything.
  if (isOwnFederationDomain(canonicalDomain)) {
    throw new UnpurgeableDomainError(
      `${canonicalDomain} is an own federation domain and can never be purged`,
    );
  }

  const spellings = candidateDomainSpellings(canonicalDomain);
  const matchWhere = and(
    eq(users.type, 'federated'),
    inArray(users.federationDomain, spellings),
  );

  const actorsMatched = await countActors(matchWhere);
  // Scan in `id` order from the cursor. The ordering is what makes `afterId` a
  // total order rather than an arbitrary one, so a resumed pass cannot skip or
  // repeat an actor.
  //
  // `id` is a `text` column holding two shapes — pre-cutover 24-hex ObjectId
  // strings and post-cutover uuid v7 — so the order is neither creation order
  // nor uniform across the two. That is fine and deliberate: a cursor needs the
  // comparison and the sort to be the SAME total order, which they are (one
  // column, one collation), not a meaningful one. Mongo's
  // `new ObjectId(afterId)` cast is gone with the ids it required; casting a
  // uuid cursor to an ObjectId would have thrown on every continuation this
  // endpoint issues.
  const scanWhere =
    options.afterId === undefined ? matchWhere : and(matchWhere, gt(users.id, options.afterId));
  const candidates = await getDb()
    .select({ id: users.id, username: users.username, domain: users.federationDomain })
    .from(users)
    .where(scanWhere)
    .orderBy(asc(users.id))
    .limit(limit);

  const result: BlockedDomainPurgeResult = {
    requestedDomain: domain,
    canonicalDomain,
    dryRun,
    actorsMatched,
    actorsProcessed: 0,
    actorsDeleted: 0,
    actorsRetained: [],
    filesDeleted: 0,
    bytesDeleted: 0,
    avatarsDeleted: 0,
    followEdgesRemoved: 0,
    localFollowersAffected: 0,
    candidatesRejected: 0,
    remaining: 0,
    // The scan reached the end when it came back short of a full batch. This is
    // the ONLY loop condition: it holds identically for a dry run, for retained
    // rows and for deletions, none of which it depends on.
    nextCursor: candidates.length > 0 ? candidates[candidates.length - 1].id : null,
    done: candidates.length < limit,
  };

  for (const candidate of candidates) {
    const storedDomain = candidate.domain;
    // RE-VERIFY against the shared canonical rule. The query above is an
    // optimisation; THIS is the authority on whether the row belongs to the
    // domain we were asked to purge.
    if (typeof storedDomain !== 'string' || !isSameFederationHost(storedDomain, canonicalDomain)) {
      result.candidatesRejected += 1;
      logger.warn('blockedDomainPurge: candidate rejected by canonical re-verification', {
        component: COMPONENT,
        oxyUserId: candidate.id,
        storedDomain,
        canonicalDomain,
      });
      continue;
    }

    const oxyUserId = candidate.id;
    const username = candidate.username ?? '';
    result.actorsProcessed += 1;

    const { callerOwned, otherAppIds } = await classifyActorFiles(
      oxyUserId,
      callerAppId,
    );

    result.localFollowersAffected += await countLocalFollowers(oxyUserId);

    for (const file of callerOwned) {
      if (dryRun || (await deleteFileBestEffort(file.id, { oxyUserId, canonicalDomain }))) {
        result.filesDeleted += 1;
        result.bytesDeleted += file.size;
      }
    }

    // File attribution is not an actor-reference ledger. Another application
    // can resolve and use this globally keyed actor without uploading a file,
    // so an empty `otherAppIds` cannot authorize deleting the actor or graph.
    if (!dryRun) {
      await getDb()
        .update(users)
        .set({ accountStatus: 'archived' })
        .where(and(eq(users.id, oxyUserId), eq(users.type, 'federated')));
      userCache.invalidate(oxyUserId);
    }
    const retentionReason = otherAppIds.length > 0
      ? 'other_application_files'
      : 'application_references_unknown';
    result.actorsRetained.push({
      oxyUserId,
      username,
      referencedByAppIds: otherAppIds,
      retentionReason,
    });
    logger.info('blockedDomainPurge: shared actor retained', {
      component: COMPONENT,
      oxyUserId,
      canonicalDomain,
      referencedByAppIds: otherAppIds,
      retentionReason,
      dryRun,
    });
  }

  // Re-counted rather than derived by arithmetic, so it reflects concurrent
  // ingest (which is live — the corpus grows while a purge runs). Purely
  // informational: `done` is the cursor's business, not this number's.
  result.remaining = await countActors(matchWhere);

  logger.info('blockedDomainPurge: pass complete', {
    component: COMPONENT,
    canonicalDomain,
    dryRun,
    callerAppId,
    actorsMatched: result.actorsMatched,
    actorsProcessed: result.actorsProcessed,
    actorsDeleted: result.actorsDeleted,
    actorsRetained: result.actorsRetained.length,
    filesDeleted: result.filesDeleted,
    bytesDeleted: result.bytesDeleted,
    localFollowersAffected: result.localFollowersAffected,
    candidatesRejected: result.candidatesRejected,
    remaining: result.remaining,
    done: result.done,
  });

  return result;
}

/** Federated user rows matching a domain, as a scalar. */
async function countActors(where: ReturnType<typeof and>): Promise<number> {
  const [row] = await getDb().select({ total: count() }).from(users).where(where);
  return row?.total ?? 0;
}

/**
 * Inbound follows from LOCAL (non-federated) users. Reported so an operator can
 * see, before executing, that a purge will remove real people's follows.
 *
 * Mongo needed two round trips (`distinct` then `countDocuments`) because the
 * follower ids and the follower TYPE lived in different collections. One join
 * answers it here, and — unlike the `$in` it replaces — it does not have to
 * materialise every follower id in the API process first.
 */
async function countLocalFollowers(oxyUserId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(userFollows)
    .innerJoin(users, eq(users.id, userFollows.followerId))
    .where(and(eq(userFollows.followedId, oxyUserId), ne(users.type, 'federated')));
  return row?.total ?? 0;
}
