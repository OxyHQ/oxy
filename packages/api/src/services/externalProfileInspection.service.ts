import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { federationService } from './federation.service';
import { safeActorSelector } from './federation/resolutionFailure';
import { FEDERATION_BRIDGE_POLICY } from '../config/federationBridgePolicy';

export interface ExternalProfileInspectionInput { actorUri: string; sourceSha: string; imageDigest: string }
export function validateProfileInspectionInput(input: ExternalProfileInspectionInput) {
  if (input.actorUri.length > 2048 || !/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9/._%+-]*$/.test(input.actorUri)) throw new Error('Invalid inspection actor');
  const url = new URL(input.actorUri);
  if (url.hostname !== 'bird.makeup' || !/^\/users\/[a-zA-Z0-9_]+$/.test(url.pathname)
    || !FEDERATION_BRIDGE_POLICY.some(entry => entry.host === url.hostname && entry.relabel === 'enabled')) throw new Error('Unreviewed inspection source');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Invalid inspection actor');
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha) || !/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error('Invalid provenance');
}
function fingerprint(bio: string | null) {
  const normalized = bio || null;
  return { empty: normalized === null, length: normalized?.length ?? 0,
    sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
}
async function snapshot(actorUri: string) {
  return getDb().transaction(async tx => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const [row] = await tx.execute<{
      observed_at: string; canonical_acct: string | null; source_user_id: string | null;
      stored_user_id: string | null; stored_username: string | null; bio: string | null; updated_at: string | null;
      exact_user_id: string | null; exact_bio: string | null; named_user_id: string | null; named_bio: string | null;
      source_count: number; identity_count: number; associated_sources: Array<{ actorUri: string; updatedAt: string }>;
    }>(sql`select transaction_timestamp() as observed_at, a.canonical_acct, i.user_id as source_user_id,
      u.id as stored_user_id, u.username as stored_username, u.bio, u.updated_at,
      exact_user.id as exact_user_id, exact_user.bio as exact_bio,
      named_user.id as named_user_id, named_user.bio as named_bio,
      (select count(*)::int from external_identity_actors other_actor join external_identities other_identity
        on other_identity.canonical_acct = other_actor.canonical_acct where other_identity.user_id = i.user_id) as source_count,
      (select count(*)::int from external_identities other_identity where other_identity.user_id = i.user_id) as identity_count,
      (select coalesce(json_agg(source_row), '[]'::json) from
        (select other_actor.actor_uri as "actorUri", other_actor.updated_at as "updatedAt"
        from external_identity_actors other_actor join external_identities other_identity
        on other_identity.canonical_acct = other_actor.canonical_acct where other_identity.user_id = i.user_id
        order by other_actor.updated_at desc, other_actor.actor_uri limit 10) source_row) as associated_sources
      from (select ${actorUri}::text as actor_uri) input
      left join external_identity_actors a on a.actor_uri = input.actor_uri
      left join external_identities i on i.canonical_acct = a.canonical_acct
      left join users u on u.id = i.user_id
      left join users exact_user on exact_user.username = a.canonical_acct
      left join users named_user on lower(btrim(named_user.username)) = a.canonical_acct
      limit 2`);
    if (!row) throw new Error('Missing inspection snapshot');
    return { observedAt: new Date(row.observed_at).toISOString(), canonicalAcct: row.canonical_acct,
      sourceUserId: row.source_user_id, storedUserId: row.stored_user_id,
      exactUsernameUserId: row.exact_user_id, normalizedUsernameUserId: row.named_user_id,
      usernameMatches: row.stored_username?.trim().toLowerCase() === row.canonical_acct,
      exactBindingMatches: !!row.source_user_id && row.source_user_id === row.exact_user_id,
      normalizedBindingMatches: !!row.source_user_id && row.source_user_id === row.named_user_id,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null, sourceCount: row.source_count, identityCount: row.identity_count,
      associatedSources: row.associated_sources.map(source => ({ actorUri: safeActorSelector(source.actorUri) ?? null, updatedAt: source.updatedAt })),
      sourceBio: row.stored_user_id ? fingerprint(row.bio) : null,
      exactUsernameBio: row.exact_user_id ? fingerprint(row.exact_bio) : null,
      normalizedUsernameBio: row.named_user_id ? fingerprint(row.named_bio) : null };
  });
}
/** No resolve/register calls. Exactly one actor observation between independent read-only snapshots. */
export async function inspectExternalProfile(input: ExternalProfileInspectionInput) {
  validateProfileInspectionInput(input);
  const before = await snapshot(input.actorUri);
  const result = await federationService.fetchActorProfileResult(input.actorUri, undefined, { readonlySigningKey: true });
  const after = await snapshot(input.actorUri);
  const remote = result.ok ? { canonicalAcct: result.profile.username, bio: fingerprint(result.profile.bio) } : null;
  return { operation: 'inspect_profile', readOnly: true, actorUri: input.actorUri, sourceSha: input.sourceSha, imageDigest: input.imageDigest, observedAt: new Date().toISOString(), before, after, remote,
    failure: result.ok ? null : { phase: result.failure.phase, reason: result.failure.reason, httpStatus: result.failure.httpStatus },
    sourceBindingStable: before.sourceUserId === after.sourceUserId && before.canonicalAcct === after.canonicalAcct,
    storedBioStable: before.sourceBio?.sha256 === after.sourceBio?.sha256,
    remoteMatchesStored: remote !== null && remote.bio.sha256 === after.sourceBio?.sha256 };
}
