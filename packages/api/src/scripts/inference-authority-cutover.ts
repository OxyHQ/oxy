#!/usr/bin/env bun
/** Explicit operator-only barrier/export. No automatic migration or authority fallback.
 * --activate requires --confirm-application=<same ID>; export never activates.
 * Artifact contains private idempotency keys: exclusive creation, mode 0600, never stdout.
 */
import { writeFile } from 'node:fs/promises';
import { canonicalize } from '@oxy.so/protocol';
import { inferenceEnvironmentSchema } from '@oxy.so/contracts';
import { connectPostgres, closePostgres } from '../config/postgres';
import {
  activateInferenceAuthorityFence,
  exportInferenceAuthorityFence,
  type InferenceAuthorityPopulation,
} from '../services/inferenceAuthorityFence.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = [
    '--application=',
    '--owner=',
    '--environment=',
    '--confirm-application=',
    '--output=',
  ];
  if (
    args.some(
      (a) =>
        a !== '--activate' && a !== '--export' && !allowed.some((prefix) => a.startsWith(prefix)),
    )
  ) {
    throw new Error('Unsupported cutover argument');
  }
  const read = (prefix: string): string | undefined => {
    const values = args.filter((a) => a.startsWith(prefix));
    if (values.length > 1) throw new Error('Duplicate cutover argument');
    return values[0]?.slice(prefix.length);
  };
  const applicationId = read('--application=');
  const ownerAccountId = read('--owner=');
  const environment = inferenceEnvironmentSchema.parse(read('--environment='));
  if (!applicationId || !ownerAccountId)
    throw new Error('Exact application and owner are required');
  const population: InferenceAuthorityPopulation = {
    applicationId,
    ownerAccountId,
    environment,
    credentialKind: 'workload',
  };
  if (args.includes('--activate') === args.includes('--export')) {
    throw new Error('Choose exactly one of --activate or --export; no implicit mutation');
  }
  await connectPostgres();
  try {
    if (args.includes('--activate')) {
      if (read('--confirm-application=') !== applicationId || read('--output=') !== undefined) {
        throw new Error('Activation requires exact explicit confirmation and no export output');
      }
      await activateInferenceAuthorityFence(population);
      process.stdout.write('Admission fence active; existing settlements remain in Oxy.\n');
    } else {
      const output = read('--output=');
      if (!output || read('--confirm-application=') !== undefined)
        throw new Error('Export requires a new private output file');
      const manifest = await exportInferenceAuthorityFence(population);
      await writeFile(output, `${canonicalize(manifest)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write(
        `Drained legacy fence manifest written: ${manifest.entries.length} entries.\n`,
      );
    }
  } finally {
    await closePostgres();
  }
}
main().catch(() => {
  // Database exception objects may carry SQL parameters; never print them.
  process.stderr.write(
    'Cutover operation refused or failed. No authority fallback is permitted.\n',
  );
  process.exitCode = 1;
});
