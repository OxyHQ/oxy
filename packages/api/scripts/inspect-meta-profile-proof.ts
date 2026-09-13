/** Fixed source-only diagnostic: no identity resolution, registry or database imports. */
import { inspectMetaFirstPartyProfilePair } from '../src/services/federation/metaFirstPartyProof.service';

async function main() {
  const values = new Map<string, string>();
  const keys = ['canonical-acct', 'source-sha', 'image-digest'];
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !keys.includes(match[1]) || values.has(match[1])) throw new Error('Invalid diagnostic argument');
    values.set(match[1], match[2]);
  }
  const canonicalAcct = values.get('canonical-acct') ?? '';
  const sourceSha = values.get('source-sha') ?? '';
  const imageDigest = values.get('image-digest') ?? '';
  if (values.size !== keys.length || !/^[a-z0-9_][a-z0-9._]{0,63}@(instagram\.com|threads\.net)$/.test(canonicalAcct)
    || !/^[0-9a-f]{40}$/.test(sourceSha) || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error('Invalid diagnostic selectors');
  const result = await inspectMetaFirstPartyProfilePair(canonicalAcct);
  const report = { ...result, operation: 'inspect_meta', readOnly: true, canonicalAcct, sourceSha, imageDigest,
    observedAt: new Date().toISOString() };
  await new Promise<void>(resolve => { process.stdout.write(`${JSON.stringify(report)}\n`, () => resolve()); });
}
void main().catch(() => { console.error('Meta inspection failed'); process.exitCode = 1; });
