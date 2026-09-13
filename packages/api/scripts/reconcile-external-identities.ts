/** Revalidate legacy bridge identity through the same Oxy discovery authority. */
import 'dotenv/config';
import { closeRedis } from '../src/config/redis';
import { asc, eq, gt } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { externalIdentityActors } from '../src/db/schema/externalIdentities';
import { users } from '../src/db/schema/users';
import { federationService } from '../src/services/federation.service';
import { revokeMetaIdentityProof } from '../src/services/federation/metaIdentityProofRegistry.service';
import { FEDERATION_BRIDGE_POLICY } from '../src/config/federationBridgePolicy';

/** Failed apply observations revoke stale proof; previews never mutate identity. */
export async function inspectReconciliationActorResult(actorUri: string, apply: boolean) {
  const observedAt = new Date();
  const result = await federationService.fetchActorProfileResult(actorUri);
  if (!result.ok && apply) await revokeMetaIdentityProof(actorUri, 'source_actor_unavailable', observedAt);
  return result;
}

export async function inspectReconciliationActor(actorUri: string, apply: boolean) {
  const result = await inspectReconciliationActorResult(actorUri, apply);
  return result.ok ? result.profile : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const cursorArg = process.argv.find(value => value.startsWith('--after='));
  let cursor = cursorArg?.slice('--after='.length) ?? '';
  const reviewed = new Set(FEDERATION_BRIDGE_POLICY.filter(entry => entry.relabel === 'enabled').map(entry => entry.host));
  let visited = 0;
  let changed = 0;
  let refused = 0;
  let pending = 0;
  await connectPostgres();
  try {
    while (true) {
      const page = await getDb().select({ actorUri: externalIdentityActors.actorUri, canonicalAcct: externalIdentityActors.canonicalAcct })
        .from(externalIdentityActors).where(gt(externalIdentityActors.actorUri, cursor)).orderBy(asc(externalIdentityActors.actorUri)).limit(100);
      if (!page.length) break;
      for (const source of page) {
        cursor = source.actorUri;
        let host: string;
        try { host = new URL(source.actorUri).hostname.replace(/^www\./, ''); } catch { continue; }
        if (!reviewed.has(host) && host !== 'threads.net' && host !== 'threads.com') continue;
        visited++;
        try {
          const inspected = await inspectReconciliationActorResult(source.actorUri, apply);
          if (!inspected.ok) {
            refused++;
            console.log(JSON.stringify({ actorUri: source.actorUri, state: 'refused', reason: inspected.failure.reason, phase: inspected.failure.phase, httpStatus: inspected.failure.httpStatus }));
            continue;
          }
          const profile = inspected.profile;
          const [stored] = await getDb().select({ bio: users.bio }).from(users).where(eq(users.username, source.canonicalAcct)).limit(1);
          const changes = profile.username !== source.canonicalAcct || profile.bio !== stored?.bio;
          let identityProof: { state: string; reason?: string } | undefined;
          if (apply) {
            // Refetching at commit time avoids persisting a dry-run document if
            // the source changed between inspection and application.
            const result = await federationService.resolveExternalActorIdentity(source.actorUri);
            if (!result) throw new Error('source changed or became unavailable');
            identityProof = result.identityProof;
            if (identityProof?.state === 'pending') pending++;
            if (identityProof?.state === 'refused') refused++;
          }
          if (changes) changed++;
          console.log(JSON.stringify({ actorUri: source.actorUri, previousAcct: source.canonicalAcct,
            canonicalAcct: profile.username, changes, applied: apply, identityProof,
            state: profile.domain === host ? 'transport_identity_retained' : 'canonicalized' }));
        } catch {
          refused++;
          console.log(JSON.stringify({ actorUri: source.actorUri, state: 'refused', reason: 'unexpected_failure' }));
        }
      }
    }
    console.log(JSON.stringify({ apply, visited, changed, refused, pending, after: cursor }));
    if (refused) process.exitCode = 2;
  } finally {
    // Resolution invalidates user caches, opening a persistent Redis socket.
    // Closing only PostgreSQL leaves completed apply tasks alive indefinitely.
    try { await closePostgres(); } finally { await closeRedis(); }
  }
}

if (require.main === module) {
  void main().catch(() => { console.error('Reconciliation failed'); process.exitCode = 1; }).then(async () => {
    // Detached avatar work belongs to the server lifecycle. A completed one-shot
    // must terminate, but only after its report and cleanup output are flushed.
    await Promise.all([process.stdout, process.stderr].map(stream =>
      new Promise<void>(resolve => { stream.write('', () => resolve()); })));
    process.exit(process.exitCode ?? 0);
  });
}
