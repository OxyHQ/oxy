import { and, asc, eq, or, sql } from 'drizzle-orm';
import { externalIdentities, externalIdentityActors } from '../db/schema/externalIdentities';
import { externalIdentityInstagramPins, externalIdentityMetaProofs } from '../db/schema/externalIdentityMetaProofs';
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
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
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
    // Lineage is narrower than the absence search: all three supplied selectors
    // must bind the exact stored actor. Never enumerate other accounts or resolve.
    const [source] = await tx.select({
      actorUri: externalIdentityActors.actorUri,
      canonicalAcct: externalIdentities.canonicalAcct,
      transportAcct: externalIdentityActors.transportAcct,
      sourceUserId: externalIdentities.userId,
      stableId: externalIdentities.stableId,
      metaProofRevokedAt: externalIdentities.metaProofRevokedAt,
    }).from(externalIdentityActors).innerJoin(externalIdentities,
      eq(externalIdentityActors.canonicalAcct, externalIdentities.canonicalAcct))
      .where(and(eq(externalIdentityActors.actorUri, input.actorUri),
        eq(externalIdentities.canonicalAcct, input.canonicalAcct),
        eq(externalIdentityActors.transportAcct, input.transportAcct))).limit(1);
    let lineage = null;
    if (source) {
      const [pin] = await tx.select({
        state: externalIdentityInstagramPins.state,
        sourceUserId: externalIdentityInstagramPins.sourceUserId,
        instagramPk: externalIdentityInstagramPins.instagramPk,
        instagramGraphId: externalIdentityInstagramPins.instagramGraphId,
        documentHash: externalIdentityInstagramPins.documentHash,
        policyVersion: externalIdentityInstagramPins.policyVersion,
        firstVerifiedAt: externalIdentityInstagramPins.firstVerifiedAt,
        verifiedAt: externalIdentityInstagramPins.verifiedAt,
      }).from(externalIdentityInstagramPins).where(and(
        eq(externalIdentityInstagramPins.actorUri, source.actorUri),
        eq(externalIdentityInstagramPins.canonicalAcct, source.canonicalAcct))).limit(1);
      const proofs = await tx.select({
        instagramActorUri: externalIdentityMetaProofs.instagramActorUri,
        threadsActorUri: externalIdentityMetaProofs.threadsActorUri,
        instagramAcct: externalIdentityMetaProofs.instagramAcct,
        threadsAcct: externalIdentityMetaProofs.threadsAcct,
        instagramPk: externalIdentityMetaProofs.instagramPk,
        instagramGraphId: externalIdentityMetaProofs.instagramGraphId,
        threadsWebPk: externalIdentityMetaProofs.threadsWebPk,
        state: externalIdentityMetaProofs.state,
        policyVersion: externalIdentityMetaProofs.policyVersion,
        instagramDocumentHash: externalIdentityMetaProofs.instagramDocumentHash,
        threadsDocumentHash: externalIdentityMetaProofs.threadsDocumentHash,
        evidenceDigest: externalIdentityMetaProofs.evidenceDigest,
        verifiedAt: externalIdentityMetaProofs.verifiedAt,
        expiresAt: externalIdentityMetaProofs.expiresAt,
        revokedAt: externalIdentityMetaProofs.revokedAt,
      }).from(externalIdentityMetaProofs).where(or(
        and(eq(externalIdentityMetaProofs.instagramActorUri, source.actorUri), eq(externalIdentityMetaProofs.instagramAcct, source.canonicalAcct)),
        and(eq(externalIdentityMetaProofs.threadsActorUri, source.actorUri), eq(externalIdentityMetaProofs.threadsAcct, source.canonicalAcct)),
      )).orderBy(asc(externalIdentityMetaProofs.instagramActorUri), asc(externalIdentityMetaProofs.threadsActorUri)).limit(101);
      if (proofs.length > 100) throw new Error('Exact actor proof history exceeds inspection bound');
      for (const proof of proofs) {
        // Stored proof references are public identifiers, never URLs carrying
        // credentials/query tokens. Corrupt evidence fails without echoing it.
        for (const actorUri of [proof.instagramActorUri, proof.threadsActorUri]) {
          validateCacheInspectionInput({ ...input, actorUri });
        }
      }
      lineage = { source, instagramPin: pin ?? null, metaProofs: proofs };
    }
    return {
      operation: 'inspect_cache' as const,
      observedAt: new Date(row.inspected_at).toISOString(),
      sourceSha: input.sourceSha,
      imageDigest: input.imageDigest,
      lineage,
      counts: { users: row.users_count, registryActors: row.actors_count, registryIdentities: row.identities_count },
      absent: row.users_count === 0 && row.actors_count === 0 && row.identities_count === 0,
    };
  });
}
