#!/usr/bin/env bun
/** The fixed inventory backfill is retired. Use explicit workload binding administration. */
export async function main() {
  throw new Error(
    'The workload v1 environment backfill is retired; provision explicit environments with bind:workload-identity.',
  );
}
if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Retired workload operation');
    process.exitCode = 1;
  });
