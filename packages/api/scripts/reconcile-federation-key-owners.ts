/**
 * Bind every federation key pair that predates `federation_key_pairs.oxy_user_id`
 * to the account lifetime it belongs to, and replace or remove the ones a handle's
 * later account inherited. Mechanism and decisions:
 * `src/services/federation/actorKeyOwners.ts`.
 *
 *   bun run packages/api/scripts/reconcile-federation-key-owners.ts           # report (dry run)
 *   bun run packages/api/scripts/reconcile-federation-key-owners.ts --apply   # write
 *
 * Options: `--batch-size=<n>` (default 200, max 1000), `--handles=a,b` to print
 * the decision for those handles. Prints one `{"handle": …}` line per listed
 * handle and a final `{"summary": …}` of counts. Never prints key material.
 * Nothing is written without `--apply`; a second `--apply` run finds nothing.
 *
 * In production it runs inside the VPC as an ECS one-shot on the live oxy-api
 * task definition with a command override.
 */
import { closePostgres, connectPostgres } from '../src/config/postgres';
import { reconcileFederationKeyOwners } from '../src/services/federation/actorKeyOwners';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const KNOWN_ARGUMENT = /^--(apply|(batch-size|handles)=.*)$/;

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((value) => !KNOWN_ARGUMENT.test(value));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}`);
  const apply = process.argv.includes('--apply');
  const rawBatch = flag('batch-size') ?? '200';
  const batchSize = Number(rawBatch);
  if (!/^\d+$/.test(rawBatch) || batchSize < 1 || batchSize > 1000) {
    throw new Error('--batch-size must be an integer between 1 and 1000');
  }
  const handles = new Set(
    (flag('handles') ?? '')
      .split(',')
      .map((handle) => handle.trim().toLowerCase())
      .filter(Boolean),
  );

  await connectPostgres();
  try {
    const summary = await reconcileFederationKeyOwners({
      apply,
      batchSize,
      handles,
      explain: (entry) => console.log(JSON.stringify(entry)),
    });
    console.log(JSON.stringify({ summary }));
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
