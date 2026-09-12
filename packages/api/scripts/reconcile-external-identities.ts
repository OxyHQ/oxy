/** Revalidate legacy bridge identity through the same Oxy discovery authority. */
import 'dotenv/config';
import { asc, eq, gt } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { externalIdentityActors } from '../src/db/schema/externalIdentities';
import { users } from '../src/db/schema/users';
import { federationService } from '../src/services/federation.service';
import { FEDERATION_BRIDGE_POLICY } from '../src/config/federationBridgePolicy';

async function main() {
  const apply = process.argv.includes('--apply');
  const cursorArg = process.argv.find(value => value.startsWith('--after='));
  let cursor = cursorArg?.slice('--after='.length) ?? '';
  const reviewed = new Set(FEDERATION_BRIDGE_POLICY.filter(entry => entry.relabel === 'enabled').map(entry => entry.host));
  let visited = 0;
  let changed = 0;
  let refused = 0;
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
        if (!reviewed.has(host)) continue;
        visited++;
        try {
          const profile = await federationService.fetchActorProfile(source.actorUri);
          if (!profile) {
            refused++;
            console.log(JSON.stringify({ actorUri: source.actorUri, state: 'refused', reason: 'source_fetch_or_identity_proof_failed' }));
            continue;
          }
          const [stored] = await getDb().select({ bio: users.bio }).from(users).where(eq(users.username, source.canonicalAcct)).limit(1);
          const changes = profile.username !== source.canonicalAcct || profile.bio !== stored?.bio;
          if (apply) {
            // Refetching at commit time avoids persisting a dry-run document if
            // the source changed between inspection and application.
            const result = await federationService.resolveExternalActorIdentity(source.actorUri);
            if (!result) throw new Error('source changed or became unavailable');
          }
          if (changes) changed++;
          console.log(JSON.stringify({ actorUri: source.actorUri, previousAcct: source.canonicalAcct,
            canonicalAcct: profile.username, changes, applied: apply,
            state: profile.domain === host ? 'transport_identity_retained' : 'canonicalized' }));
        } catch (error) {
          refused++;
          console.log(JSON.stringify({ actorUri: source.actorUri, state: 'refused', reason: error instanceof Error ? error.message : 'unknown' }));
        }
      }
    }
    console.log(JSON.stringify({ apply, visited, changed, refused, after: cursor }));
    if (refused) process.exitCode = 2;
  } finally { await closePostgres(); }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Reconciliation failed'); process.exitCode = 1; });
