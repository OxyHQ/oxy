#!/usr/bin/env bun
/** Operator-only: input is deployment metadata, never credentials or customer content. */
import { readFile } from 'node:fs/promises';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  parseManagedApplicationDeclaration,
  registerManagedApplicationDeployment,
} from '../src/services/managedApplicationDeployment.service';

async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: register-managed-mention.ts declaration.json');
  const declaration: unknown = JSON.parse(await readFile(path, 'utf8'));
  // The service validates the whole untrusted document before opening a transaction.
  const input = parseManagedApplicationDeclaration(declaration);
  await connectPostgres();
  try {
    const result = await registerManagedApplicationDeployment(input, {
      isPlatformStaff: true,
      describedAs: 'an operator with direct database access',
    });
    process.stdout.write(`MANAGED_APPLICATION_JSON=${JSON.stringify(result)}\n`);
  } finally {
    await closePostgres();
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Registration failed'}\n`);
    process.exitCode = 1;
  });
