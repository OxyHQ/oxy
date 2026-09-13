import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';

export interface ExternalIdentityCacheInspectionInput {
  actorUri: string;
  canonicalAcct: string;
  transportAcct: string;
  sourceSha: string;
  imageDigest: string;
}

/** Fixed identifiers only. No arbitrary queries, URLs to fetch, or profile writes. */
export function validateCacheInspectionInput(input: ExternalIdentityCacheInspectionInput) {
  const acct = /^[a-z0-9_][a-z0-9_.-]{0,127}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
  for (const value of [input.canonicalAcct, input.transportAcct]) {
    if (!acct.test(value) || !value.split('@')[1].includes('.')) throw new Error('Invalid cache inspection account');
  }
  if (input.actorUri.length > 2048 || !/^https:\/\/[a-zA-Z0-9:/._%+-]+$/.test(input.actorUri)) throw new Error('Invalid cache inspection actor URI');
  const actor = new URL(input.actorUri);
  if (actor.protocol !== 'https:' || actor.username || actor.password || actor.port || actor.search || actor.hash) throw new Error('Invalid cache inspection actor URI');
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha) || !/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error('Invalid deployed image provenance');
}

/** A single read-only snapshot includes private, archived and unregistered legacy users. */
export async function inspectExternalIdentityCache(input: ExternalIdentityCacheInspectionInput) {
  validateCacheInspectionInput(input);
  return getDb().transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const [row] = await tx.execute<{ inspected_at: Date; users_count: number; actors_count: number; identities_count: number }>(sql`
      select transaction_timestamp() as inspected_at,
        (select count(*)::int from users
          where federation_actor_uri = ${input.actorUri}
          or lower(ltrim(btrim(username), '@')) in (${input.canonicalAcct}, ${input.transportAcct})) as users_count,
        (select count(*)::int from external_identity_actors
          where actor_uri = ${input.actorUri} or transport_acct = ${input.transportAcct}
          or canonical_acct in (${input.canonicalAcct}, ${input.transportAcct})) as actors_count,
        (select count(*)::int from external_identities
          where canonical_acct in (${input.canonicalAcct}, ${input.transportAcct})) as identities_count
    `);
    return {
      operation: 'inspect_cache' as const,
      observedAt: new Date(row.inspected_at).toISOString(),
      sourceSha: input.sourceSha,
      imageDigest: input.imageDigest,
      counts: { users: row.users_count, registryActors: row.actors_count, registryIdentities: row.identities_count },
      absent: row.users_count === 0 && row.actors_count === 0 && row.identities_count === 0,
    };
  });
}
