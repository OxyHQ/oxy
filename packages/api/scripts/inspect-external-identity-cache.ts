/** Fixed read-only cold-discovery precheck. Never imports federation discovery. */
import 'dotenv/config';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { inspectExternalIdentityCache, validateCacheInspectionInput } from '../src/services/externalIdentityCacheInspection.service';

async function main() {
  const keys = ['actor-uri', 'canonical-acct', 'transport-acct', 'source-sha', 'image-digest'];
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !keys.includes(match[1]) || args.has(match[1])) throw new Error('Invalid cache inspection argument');
    args.set(match[1], match[2]);
  }
  if (args.size !== keys.length) throw new Error('All fixed cache inspection arguments are required');
  const requiredArg = (key: string): string => {
    const value = args.get(key);
    if (value === undefined) throw new Error('Missing cache inspection argument');
    return value;
  };
  const input = { actorUri: requiredArg('actor-uri'), canonicalAcct: requiredArg('canonical-acct'), transportAcct: requiredArg('transport-acct'), sourceSha: requiredArg('source-sha'), imageDigest: requiredArg('image-digest') };
  validateCacheInspectionInput(input);
  await connectPostgres();
  try { console.log(JSON.stringify(await inspectExternalIdentityCache(input))); }
  finally { await closePostgres(); }
}
void main().catch(() => { console.error('Cache inspection failed'); process.exitCode = 1; });
