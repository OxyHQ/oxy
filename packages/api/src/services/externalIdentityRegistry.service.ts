import { ConflictError } from '../utils/error';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../config/postgres';
import { canonicalUserRedirects, externalIdentities, externalIdentityActors, externalIdentityClaims } from '../db/schema/externalIdentities';
import { users } from '../db/schema/users';
import { blocks } from '../db/schema/blocks';
import { restrictions } from '../db/schema/restrictions';
import { userFollows } from '../db/schema/userFollows';
import { followTargets } from '../db/schema/followTargets';
import { followRelationships } from '../db/schema/followRelationships';
import { followApplicationOverrides } from '../db/schema/followApplicationOverrides';

export interface RegisterExternalIdentityInput {
  canonicalAcct: string;
  actorUri: string;
  transportAcct: string;
  protocol: string;
  profile: { displayName?: string; bio?: string; avatarUrl?: string };
  /** Only source-controlled, verified rel=me / alsoKnownAs links, never biography text. */
  evidenceLinks?: string[];
  stableId?: string;
}

export function normalizeExternalAcct(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

async function resolvePhysicalUserId(id: string, db: DatabaseOrTransaction = getDb()): Promise<string> {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const [redirect] = await db.select().from(canonicalUserRedirects).where(eq(canonicalUserRedirects.userId, id));
    if (!redirect) return id;
    id = redirect.canonicalUserId;
  }
  throw new Error('Canonical user redirect cycle');
}

export async function lookupExternalIdentity(value: string): Promise<string | null> {
  const db = getDb();
  const [identity] = await db.select({ userId: externalIdentities.userId }).from(externalIdentities)
    .where(eq(externalIdentities.canonicalAcct, normalizeExternalAcct(value)));
  if (identity) return resolveCanonicalUserId(identity.userId, db);
  const [actor] = await db.select({ userId: externalIdentities.userId }).from(externalIdentityActors)
    .innerJoin(externalIdentities, eq(externalIdentities.canonicalAcct, externalIdentityActors.canonicalAcct))
    .where(or(eq(externalIdentityActors.actorUri, value), eq(externalIdentityActors.transportAcct, normalizeExternalAcct(value))));
  return actor ? resolveCanonicalUserId(actor.userId, db) : null;
}

/** One SQL identity graph for hydration, graph checks, search, and pagination. */
function externalIdentityGroupCtes(seedQuery: SQL): SQL {
  return sql`
    with recursive roots(root_id) as (${seedQuery}), linked(a, b) as (
      select source.user_id, target.user_id from external_identity_claims claim
      join external_identity_actors actor on actor.actor_uri = claim.actor_uri
      join external_identities source on source.canonical_acct = actor.canonical_acct
      join external_identities target on target.canonical_acct = claim.target_acct
      where claim.state = 'linked' and claim.source_stable_id = source.stable_id and claim.target_stable_id = target.stable_id and actor.updated_at > now() - interval '7 days'
      and exists (select 1 from external_identity_claims reverse
        join external_identity_actors reverse_actor on reverse_actor.actor_uri = reverse.actor_uri
        where reverse_actor.canonical_acct = claim.target_acct and reverse.target_acct = actor.canonical_acct
        and reverse.source_stable_id = target.stable_id and reverse.target_stable_id = source.stable_id and reverse.state = 'linked' and reverse_actor.updated_at > now() - interval '7 days')
    ) , members(root_id, user_id) as (
      select roots.root_id, coalesce(redirect.canonical_user_id, roots.root_id)
      from roots left join canonical_user_redirects redirect on redirect.user_id = roots.root_id union
      select members.root_id, case when linked.a = members.user_id then linked.b else linked.a end
      from members join linked on linked.a = members.user_id or linked.b = members.user_id
    )`;
}

/** Canonicalize an entire candidate set before ranking, OFFSET and LIMIT. */
export function canonicalExternalUserIdsQuery(seedQuery: SQL): SQL {
  return sql`(select distinct user_id from (${canonicalExternalUserMapQuery(seedQuery)}) canonical_users)`;
}

export function canonicalExternalUserMapQuery(seedQuery: SQL): SQL {
  return sql`${externalIdentityGroupCtes(seedQuery)}
    select members.root_id as source_user_id, coalesce(min(identity.user_id), min(members.user_id)) as user_id
    from members left join external_identities identity on identity.user_id = members.user_id
    join users visible_member on visible_member.id = members.user_id
    group by members.root_id
    having bool_and(visible_member.account_status <> 'archived' and visible_member.reputation_tier <> 'restricted' and visible_member.privacy_is_private_account = false)`;
}

export async function getEquivalentUserGroups(userIds: string[], db: DatabaseOrTransaction = getDb()): Promise<Record<string, string[]>> {
  if (!userIds.length) return {};
  const seeds = sql.join([...new Set(userIds)].map(id => sql`(${id}::text)`), sql`, `);
  const rows = await db.execute<{ root_id: string; user_id: string }>(sql`
    ${externalIdentityGroupCtes(sql`values ${seeds}`)}
    select root_id, user_id from members
    union select members.root_id, redirect.user_id from canonical_user_redirects redirect
    join members on members.user_id = redirect.canonical_user_id
  `);
  const groups: Record<string, string[]> = {};
  for (const row of rows) (groups[row.root_id] ??= []).push(row.user_id);
  return groups;
}

export async function getEquivalentUserIds(userId: string, db: DatabaseOrTransaction = getDb()): Promise<string[]> {
  return (await getEquivalentUserGroups([userId], db))[userId] ?? [userId];
}

export async function expandEquivalentUserIds(userIds: string[], db: DatabaseOrTransaction = getDb()): Promise<string[]> {
  return [...new Set(Object.values(await getEquivalentUserGroups(userIds, db)).flat())];
}

export async function resolveCanonicalUserId(id: string, db: DatabaseOrTransaction = getDb()): Promise<string> {
  const ids = await getEquivalentUserIds(id, db);
  const [identity] = await db.select().from(externalIdentities).where(inArray(externalIdentities.userId, ids)).orderBy(externalIdentities.userId).limit(1);
  return identity?.userId ?? resolvePhysicalUserId(id, db);
}

export async function getCanonicalUserRedirects(userId: string): Promise<string[]> {
  const canonical = await resolveCanonicalUserId(userId);
  return (await getEquivalentUserIds(canonical)).filter(id => id !== canonical);
}

export async function getExternalIdentitiesForUser(userId: string) {
  return getDb().select({ sourceUserId: externalIdentities.userId, canonicalAcct: externalIdentities.canonicalAcct, network: externalIdentities.network,
    protocol: externalIdentityActors.protocol, actorUri: externalIdentityActors.actorUri,
    transportAcct: externalIdentityActors.transportAcct }).from(externalIdentities)
    .innerJoin(externalIdentityActors, eq(externalIdentityActors.canonicalAcct, externalIdentities.canonicalAcct))
    .where(inArray(externalIdentities.userId, await getEquivalentUserIds(userId)));
}

/** A reciprocal explicit source link is required even when handles happen to match. */
export function linkedSourceAcct(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.replace(/^www\./, '');
    const match = url.pathname.match(/^\/@?([a-zA-Z0-9._]+)\/?$/);
    if (!match || !['instagram.com', 'threads.net', 'threads.com'].includes(host)) return null;
    return `${match[1].toLowerCase()}@${host === 'threads.com' ? 'threads.net' : host}`;
  } catch { return null; }
}

async function mergeUsers(tx: Transaction, from: string, to: string) {
  if (from === to) return;
  const candidates = await tx.select().from(users).where(or(eq(users.id, from), eq(users.id, to))).for('update');
  if (candidates.length !== 2 || candidates.some(user => user.type !== 'federated')) throw new Error('Only external users may converge');
  // Keep originals for historical references; copy moderation to the canonical account first.
  for (const row of await tx.select().from(blocks).where(or(eq(blocks.userId, from), eq(blocks.blockedId, from)))) {
    const { id: _id, ...copy } = row;
    await tx.insert(blocks).values({ ...copy, userId: row.userId === from ? to : row.userId, blockedId: row.blockedId === from ? to : row.blockedId }).onConflictDoNothing();
  }
  for (const row of await tx.select().from(restrictions).where(or(eq(restrictions.userId, from), eq(restrictions.restrictedId, from)))) {
    const { id: _id, ...copy } = row;
    await tx.insert(restrictions).values({ ...copy, userId: row.userId === from ? to : row.userId, restrictedId: row.restrictedId === from ? to : row.restrictedId }).onConflictDoNothing();
  }
  for (const row of await tx.select().from(userFollows).where(or(eq(userFollows.followerId, from), eq(userFollows.followedId, from)))) {
    const { id: _id, ...copy } = row;
    const followerId = row.followerId === from ? to : row.followerId;
    const followedId = row.followedId === from ? to : row.followedId;
    if (followerId !== followedId) await tx.insert(userFollows).values({ ...copy, followerId, followedId }).onConflictDoNothing();
    await tx.delete(userFollows).where(eq(userFollows.id, row.id));
  }
  const [oldTarget] = await tx.select().from(followTargets).where(eq(followTargets.localUserId, from));
  const [newTarget] = await tx.select().from(followTargets).where(eq(followTargets.localUserId, to));
  if (oldTarget && !newTarget) await tx.update(followTargets).set({ localUserId: to }).where(eq(followTargets.id, oldTarget.id));
  {
    const affected = oldTarget && newTarget ? or(eq(followRelationships.followTargetId, oldTarget.id), eq(followRelationships.followerUserId, from)) : eq(followRelationships.followerUserId, from);
    for (const edge of await tx.select().from(followRelationships).where(affected)) {
      const followTargetId = oldTarget && newTarget && edge.followTargetId === oldTarget.id ? newTarget.id : edge.followTargetId;
      const followerUserId = edge.followerUserId === from ? to : edge.followerUserId;
      const [existing] = await tx.select().from(followRelationships).where(and(eq(followRelationships.followerUserId, followerUserId), eq(followRelationships.followTargetId, followTargetId)));
      if (!existing || existing.id === edge.id) {
        await tx.update(followRelationships).set({ followTargetId, followerUserId }).where(eq(followRelationships.id, edge.id));
      } else {
        // A rejection beats a request; an established active follow stays active.
        const state = [existing.state, edge.state].includes('active') ? 'active' : [existing.state, edge.state].includes('rejected') ? 'rejected' : 'requested';
        await tx.update(followRelationships).set({ state }).where(eq(followRelationships.id, existing.id));
        for (const override of await tx.select().from(followApplicationOverrides).where(eq(followApplicationOverrides.relationshipId, edge.id))) {
          const { id: _id, ...copy } = override;
          await tx.insert(followApplicationOverrides).values({ ...copy, relationshipId: existing.id }).onConflictDoUpdate({ target: [followApplicationOverrides.relationshipId, followApplicationOverrides.applicationId], set: { mode: sql`case when ${followApplicationOverrides.mode} = 'disabled' or ${override.mode} = 'disabled' then 'disabled' else 'enabled' end` } });
        }
        // Events intentionally have no relationship foreign key: history survives deduplication.
        await tx.delete(followRelationships).where(eq(followRelationships.id, edge.id));
      }
    }
  }
  await tx.update(externalIdentities).set({ userId: to }).where(eq(externalIdentities.userId, from));
  await tx.update(canonicalUserRedirects).set({ canonicalUserId: to }).where(eq(canonicalUserRedirects.canonicalUserId, from));
  await tx.insert(canonicalUserRedirects).values({ userId: from, canonicalUserId: to }).onConflictDoNothing();
}

/** Refuse irreversible transport convergence when historical ownership conflicts. */
function assertCompatibleSource(existing: typeof users.$inferSelect, input: RegisterExternalIdentityInput, storedStableId?: string | null) {
  if (!existing.federationActorUri) throw new ConflictError('Existing external account has no verifiable source binding');
  if (existing.federationActorUri === input.actorUri) return;
  const historicalStableId = storedStableId ?? (existing.federationActorUri.startsWith('did:') ? existing.federationActorUri : undefined);
  if (historicalStableId || input.stableId) {
    if (!historicalStableId || historicalStableId !== input.stableId) {
      throw new ConflictError('External source ownership is not proven to match the existing account');
    }
    return;
  }
  // Recyclable handles retain a documented residual risk. A contradictory
  // nonempty profile is nevertheless a refusal, never a last-writer merge.
  const normalizeName = (value: string | null | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const previousName = normalizeName(existing.nameDisplay || [existing.nameFirst, existing.nameLast].filter(Boolean).join(' '));
  const incomingName = normalizeName(input.profile.displayName);
  if (previousName && incomingName && previousName !== incomingName) {
    throw new ConflictError('External source profile contradicts the existing account');
  }
}

export async function registerExternalIdentity(input: RegisterExternalIdentityInput) {
  // Persist bounded source claims only; immutable identity proof has its own field.
  input = { ...input, evidenceLinks: [...new Set((input.evidenceLinks ?? [])
    .filter(link => typeof link === 'string' && link.length <= 2048 && linkedSourceAcct(link) !== null))].slice(0, 32) };
  const canonicalAcct = normalizeExternalAcct(input.canonicalAcct);
  const network = canonicalAcct.slice(canonicalAcct.lastIndexOf('@') + 1);
  if (!canonicalAcct.includes('@') || !input.actorUri || !network) throw new Error('Invalid external identity');
  return getDb().transaction(async tx => {
    // Serializes convergence across networks as well as concurrent bridge discovery.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('external-identity-registry'))`);
    let [identity] = await tx.select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, canonicalAcct));
    if (identity?.stableId && input.stableId && identity.stableId !== input.stableId) throw new Error('External stable identity changed; explicit ownership reconciliation required');
    const [actor] = await tx.select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, input.actorUri));
    if (identity && (!actor || actor.canonicalAcct !== canonicalAcct)) {
      const [existing] = await tx.select().from(users).where(eq(users.id, identity.userId));
      if (existing) assertCompatibleSource(existing, input, identity.stableId);
    }
    if (actor && actor.canonicalAcct !== canonicalAcct) {
      // Only a migration transport key may be promoted to its source account.
      const [previous] = await tx.select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, actor.canonicalAcct));
      const sameSubject = !!input.stableId && previous?.stableId === input.stableId && previous.network === network;
      if (!sameSubject && actor.canonicalAcct !== normalizeExternalAcct(input.transportAcct)) throw new Error('Actor already belongs to another external identity');
    }
    const [legacy] = await tx.select().from(users).where(eq(users.federationActorUri, input.actorUri));
    if (legacy && legacy.type !== 'federated') throw new ConflictError('External actor belongs to a non-federated account');
    if (!identity) {
      const [named] = await tx.select().from(users).where(sql`lower(btrim(${users.username})) = ${canonicalAcct}`);
      if (named && named.type !== 'federated') throw new ConflictError('External identity conflicts with local user');
      if (named) assertCompatibleSource(named, input);
      const [sameSubject] = input.stableId ? await tx.select().from(externalIdentities).where(and(eq(externalIdentities.stableId, input.stableId), eq(externalIdentities.network, network))).limit(1) : [];
      let userId = sameSubject?.userId ?? named?.id ?? legacy?.id;
      if (!userId) {
        const [user] = await tx.insert(users).values({ username: canonicalAcct, type: 'federated', federationActorUri: input.actorUri,
          federationDomain: network, nameFirst: input.profile.displayName || null, nameDisplay: input.profile.displayName || null, bio: input.profile.bio || null, description: input.profile.bio || null }).returning();
        userId = user.id;
      }
      [identity] = await tx.insert(externalIdentities).values({ canonicalAcct, userId, network, stableId: input.stableId, evidenceLinks: input.evidenceLinks ?? [] }).returning();
    } else {
      const canonicalId = await resolvePhysicalUserId(identity.userId, tx);
      if (legacy) await mergeUsers(tx, await resolvePhysicalUserId(legacy.id, tx), canonicalId);
      [identity] = await tx.update(externalIdentities).set({ evidenceLinks: input.evidenceLinks ?? identity.evidenceLinks,
        stableId: input.stableId ?? identity.stableId }).where(eq(externalIdentities.canonicalAcct, canonicalAcct)).returning();
    }
    if (legacy) await mergeUsers(tx, await resolvePhysicalUserId(legacy.id, tx), identity.userId);
    await tx.update(users).set({ username: canonicalAcct, federationDomain: network,
      nameFirst: input.profile.displayName || null, nameDisplay: input.profile.displayName || null, bio: input.profile.bio || null, description: input.profile.bio || null,
      federationLastResolvedAt: new Date(), federationUnavailableAt: null, federationUnavailableReason: null }).where(eq(users.id, identity.userId));
    const actorValues = { canonicalAcct, transportAcct: normalizeExternalAcct(input.transportAcct), protocol: input.protocol, evidenceLinks: input.evidenceLinks ?? [] };
    await tx.insert(externalIdentityActors).values({ actorUri: input.actorUri, ...actorValues })
      .onConflictDoUpdate({ target: externalIdentityActors.actorUri, set: actorValues });
    if (actor && actor.canonicalAcct !== canonicalAcct) {
      const remaining = await tx.select().from(externalIdentityActors).where(eq(externalIdentityActors.canonicalAcct, actor.canonicalAcct));
      if (!remaining.length) await tx.delete(externalIdentities).where(eq(externalIdentities.canonicalAcct, actor.canonicalAcct));
    }
    const claimed = (input.evidenceLinks ?? []).map(linkedSourceAcct).filter((acct): acct is string => !!acct && acct !== canonicalAcct && acct.split('@')[1] !== network);
    const oldClaims = await tx.select().from(externalIdentityClaims).where(eq(externalIdentityClaims.actorUri, input.actorUri));
    for (const claim of oldClaims) {
      if (!claimed.includes(claim.targetAcct)) {
        await tx.update(externalIdentityClaims).set({ state: 'revoked' }).where(and(eq(externalIdentityClaims.actorUri, input.actorUri), eq(externalIdentityClaims.targetAcct, claim.targetAcct)));
        // The reverse claim is pending once reciprocity disappears.
        await tx.execute(sql`update external_identity_claims set state = 'pending', updated_at = now()
          where target_acct = ${canonicalAcct} and state = 'linked' and actor_uri in
          (select actor_uri from external_identity_actors where canonical_acct = ${claim.targetAcct})`);
      }
    }
    if (['instagram.com', 'threads.net'].includes(network)) {
      for (const linked of claimed) {
        const [targetIdentity] = await tx.select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, linked));
        const reverse = await tx.select({ actorUri: externalIdentityClaims.actorUri, sourceStableId: externalIdentityClaims.sourceStableId }).from(externalIdentityClaims)
          .innerJoin(externalIdentityActors, eq(externalIdentityActors.actorUri, externalIdentityClaims.actorUri))
          .where(and(eq(externalIdentityActors.canonicalAcct, linked), eq(externalIdentityClaims.targetAcct, canonicalAcct),
            sql`${externalIdentityClaims.state} <> 'revoked'`, sql`${externalIdentityActors.updatedAt} > now() - interval '7 days'`));
        const state = input.stableId && targetIdentity?.stableId && reverse.some(claim => claim.sourceStableId === targetIdentity.stableId) ? 'linked' : 'pending';
        const pins = { sourceStableId: input.stableId ?? null, targetStableId: targetIdentity?.stableId ?? null };
        await tx.insert(externalIdentityClaims).values({ actorUri: input.actorUri, targetAcct: linked, state, ...pins })
          .onConflictDoUpdate({ target: [externalIdentityClaims.actorUri, externalIdentityClaims.targetAcct], set: { state, ...pins } });
        for (const claim of reverse) await tx.update(externalIdentityClaims).set({ state: claim.sourceStableId === targetIdentity?.stableId ? state : 'pending', targetStableId: input.stableId ?? null })
          .where(and(eq(externalIdentityClaims.actorUri, claim.actorUri), eq(externalIdentityClaims.targetAcct, canonicalAcct)));
      }
    }
    return { userId: await resolveCanonicalUserId(identity.userId, tx), identity };
  }).catch(async (error: unknown) => {
    if (error instanceof Error && error.message.startsWith('External stable identity changed')) {
      // A contradictory source owner must immediately invalidate earlier equivalence.
      await getDb().execute(sql`update external_identity_claims set state = 'revoked', updated_at = now()
        where target_acct = ${canonicalAcct} or actor_uri in
        (select actor_uri from external_identity_actors where canonical_acct = ${canonicalAcct})`);
    }
    throw error;
  });
}

/** One group query and one actor query regardless of a profile page's size. */
export async function resolveExternalIdentityUsers(userIds: string[]) {
  const groups = await getEquivalentUserGroups(userIds);
  const members = [...new Set(Object.values(groups).flat())];
  const result = new Map<string, { userId: string; externalIdentities: Awaited<ReturnType<typeof getExternalIdentitiesForUser>>; redirectedUserIds: string[] }>();
  if (!members.length) return result;
  const identities = await getDb().select({ sourceUserId: externalIdentities.userId, canonicalAcct: externalIdentities.canonicalAcct, network: externalIdentities.network,
    protocol: externalIdentityActors.protocol, actorUri: externalIdentityActors.actorUri, transportAcct: externalIdentityActors.transportAcct })
    .from(externalIdentities).innerJoin(externalIdentityActors, eq(externalIdentityActors.canonicalAcct, externalIdentities.canonicalAcct))
    .where(inArray(externalIdentities.userId, members));
  for (const requested of userIds) {
    const ids = groups[requested] ?? [requested];
    const matched = identities.filter(identity => ids.includes(identity.sourceUserId));
    const userId = matched.map(identity => identity.sourceUserId).sort()[0] ?? requested;
    result.set(requested, { userId, externalIdentities: matched, redirectedUserIds: ids.filter(id => id !== userId) });
  }
  return result;
}
