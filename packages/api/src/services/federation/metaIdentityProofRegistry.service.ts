import { and, eq, or, sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';
import { externalIdentityMetaProofs } from '../../db/schema/externalIdentityMetaProofs';

export interface BoundMetaIdentityProof {
  instagramActorUri: string;
  threadsActorUri: string;
  instagramAcct: string;
  threadsAcct: string;
  instagramPk: string;
  instagramGraphId: string;
  threadsWebPk: string;
  instagramProfileUrl: string;
  threadsProfileUrl: string;
  policyVersion: string;
  instagramDocumentHash: string;
  threadsDocumentHash: string;
  evidenceDigest: string;
  verifiedAt: Date;
}
export type MetaIdentityProofOutcome = { state: 'verified' | 'pending' | 'refused'; reason?: string };

/** A failed fresh verification cannot keep a previously linked source group alive. */
export async function revokeMetaIdentityProof(identifier: string, reason: string, observedAt = new Date()): Promise<void> {
  await getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('external-identity-registry'))`);
    await tx.execute(sql`update external_identities set meta_proof_revoked_at = greatest(meta_proof_revoked_at, ${observedAt.toISOString()}::timestamptz)
      where canonical_acct = ${identifier} or canonical_acct in (select canonical_acct from external_identity_actors where actor_uri = ${identifier})`);
    await tx.update(externalIdentityMetaProofs).set({ state: 'revoked', revokedAt: observedAt, revocationReason: reason.slice(0, 80) })
      .where(and(sql`${externalIdentityMetaProofs.verifiedAt} <= ${observedAt.toISOString()}::timestamptz`, or(eq(externalIdentityMetaProofs.instagramAcct, identifier), eq(externalIdentityMetaProofs.threadsAcct, identifier),
        eq(externalIdentityMetaProofs.instagramActorUri, identifier), eq(externalIdentityMetaProofs.threadsActorUri, identifier))));
  });
}

/** Called only after first-party badge reciprocity AND authoritative AP/WebFinger binding. */
export async function recordMetaIdentityProof(proof: BoundMetaIdentityProof, enrollment: { createdInstagramUserId?: string }): Promise<MetaIdentityProofOutcome> {
  const now = new Date();
  if (!Number.isFinite(proof.verifiedAt.getTime()) || proof.verifiedAt > now || now.getTime() - proof.verifiedAt.getTime() > 5 * 60_000) {
    return { state: 'refused', reason: 'proof_not_fresh' };
  }
  return getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('external-identity-registry'))`);
    const sources = await tx.select({ canonicalAcct: externalIdentities.canonicalAcct, stableId: externalIdentities.stableId,
      userId: externalIdentities.userId, revokedAt: externalIdentities.metaProofRevokedAt, actorUri: externalIdentityActors.actorUri }).from(externalIdentityActors)
      .innerJoin(externalIdentities, eq(externalIdentityActors.canonicalAcct, externalIdentities.canonicalAcct))
      .where(or(eq(externalIdentityActors.actorUri, proof.instagramActorUri), eq(externalIdentityActors.actorUri, proof.threadsActorUri)));
    const instagram = sources.find(source => source.actorUri === proof.instagramActorUri && source.canonicalAcct === proof.instagramAcct);
    const threads = sources.find(source => source.actorUri === proof.threadsActorUri && source.canonicalAcct === proof.threadsAcct);
    const related = await tx.select().from(externalIdentityMetaProofs).where(or(
      eq(externalIdentityMetaProofs.instagramAcct, proof.instagramAcct), eq(externalIdentityMetaProofs.threadsAcct, proof.threadsAcct)));
    if (related.some(row => row.verifiedAt > proof.verifiedAt)) {
      return { state: 'refused', reason: 'proof_older_than_recorded_observation' };
    }
    const previous = related.find(row => row.instagramActorUri === proof.instagramActorUri && row.threadsActorUri === proof.threadsActorUri);
    if (previous && previous.verifiedAt > proof.verifiedAt) return { state: 'refused', reason: 'proof_older_than_recorded_observation' };
    const instagramStableId = `instagram:pk:${proof.instagramPk}`;
    const contradictory = !instagram || !threads || threads.stableId !== proof.threadsActorUri
      || (instagram.stableId !== null && instagram.stableId !== instagramStableId)
      || (previous && (previous.instagramPk !== proof.instagramPk || previous.instagramGraphId !== proof.instagramGraphId || previous.threadsWebPk !== proof.threadsWebPk));
    if (contradictory) {
      await tx.execute(sql`update external_identities set meta_proof_revoked_at = greatest(meta_proof_revoked_at, ${proof.verifiedAt.toISOString()}::timestamptz)
        where canonical_acct in (${proof.instagramAcct}, ${proof.threadsAcct})`);
      await tx.update(externalIdentityMetaProofs).set({ state: 'revoked', revokedAt: proof.verifiedAt, revocationReason: 'source_binding_changed' })
        .where(and(sql`${externalIdentityMetaProofs.verifiedAt} <= ${proof.verifiedAt.toISOString()}::timestamptz`, or(eq(externalIdentityMetaProofs.instagramAcct, proof.instagramAcct), eq(externalIdentityMetaProofs.threadsAcct, proof.threadsAcct))));
      return { state: 'refused', reason: 'source_binding_changed' };
    }
    if ([instagram.revokedAt, threads.revokedAt].some(revokedAt => revokedAt && revokedAt >= proof.verifiedAt)) {
      return { state: 'refused', reason: 'proof_predates_revocation' };
    }
    // A current profile URL cannot establish historical ownership of a recycled
    // bridge handle. Only a newly-created source user or already-pinned owner may enroll.
    const eligible = instagram.stableId === instagramStableId || enrollment.createdInstagramUserId === instagram.userId;
    const state = eligible ? 'verified' : 'pending';
    const reason = eligible ? undefined : 'legacy_source_lineage_unproven';
    if (eligible && instagram.stableId === null) {
      await tx.update(externalIdentities).set({ stableId: instagramStableId }).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
    }
    // Platform badges assert one current counterpart. A changed badge invalidates
    // the old edge without moving either source's history into the new group.
    for (const prior of related) {
      if (prior.state === 'revoked') continue;
      if (prior.instagramActorUri === proof.instagramActorUri && prior.threadsActorUri === proof.threadsActorUri) continue;
      await tx.update(externalIdentityMetaProofs).set({ state: 'revoked', revokedAt: proof.verifiedAt, revocationReason: 'counterpart_changed' })
        .where(and(eq(externalIdentityMetaProofs.instagramActorUri, prior.instagramActorUri), eq(externalIdentityMetaProofs.threadsActorUri, prior.threadsActorUri)));
      const displacedAcct = prior.instagramAcct === proof.instagramAcct ? prior.threadsAcct : prior.instagramAcct;
      await tx.execute(sql`update external_identities set meta_proof_revoked_at = greatest(meta_proof_revoked_at, ${proof.verifiedAt.toISOString()}::timestamptz) where canonical_acct = ${displacedAcct}`);
    }
    const row = { ...proof, state, expiresAt: new Date(proof.verifiedAt.getTime() + 24 * 60 * 60_000),
      revokedAt: null, revocationReason: reason ?? null } as const;
    await tx.insert(externalIdentityMetaProofs).values(row).onConflictDoUpdate({
      target: [externalIdentityMetaProofs.instagramActorUri, externalIdentityMetaProofs.threadsActorUri], set: row,
    });
    return { state, ...(reason ? { reason } : {}) };
  });
}
