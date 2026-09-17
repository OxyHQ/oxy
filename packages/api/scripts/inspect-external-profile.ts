/** Fixed read-only profile reconciliation observation; never resolves or persists an identity. */
import 'dotenv/config';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { closeRedis } from '../src/config/redis';
import { inspectExternalProfile, validateProfileInspectionInput } from '../src/services/externalProfileInspection.service';
async function main() {
  const keys = ['actor-uri', 'source-sha', 'image-digest'];
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !keys.includes(match[1]) || args.has(match[1])) throw new Error('Invalid inspection argument');
    args.set(match[1], match[2]);
  }
  if (args.size !== keys.length) throw new Error('Missing inspection arguments');
  const input = { actorUri: args.get('actor-uri') ?? '', sourceSha: args.get('source-sha') ?? '', imageDigest: args.get('image-digest') ?? '' };
  validateProfileInspectionInput(input);
  await connectPostgres();
  try {
    const report = await inspectExternalProfile(input);
    await new Promise<void>(resolve => { process.stdout.write(`${JSON.stringify(report)}\n`, () => resolve()); });
  } finally { try { await closePostgres(); } finally { await closeRedis(); } }
}
void main().catch(() => { console.error('Profile inspection failed'); process.exitCode = 1; }).then(async () => {
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(resolve => { stream.write('', () => resolve()); })));
  process.exit(process.exitCode ?? 0);
});
