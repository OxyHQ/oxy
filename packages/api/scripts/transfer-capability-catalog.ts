#!/usr/bin/env bun
/**
 * Move a capability catalog namespace to the application that serves it now
 * (`services/capabilityCatalogTransfer.service.ts` says when and why).
 *
 * Running this IS the staff check: there is no route, and the entry fee is a
 * terminal with this environment's `DATABASE_URL`, as for
 * `bind-workload-identity.ts`. Grant the target `catalog:<slug>` first (the
 * application seed); the move refuses a target without it.
 *
 * Usage:
 *   bun run packages/api/scripts/transfer-capability-catalog.ts \
 *     --app-id noted --to-application-id <application id> [--dry-run]
 *
 * Prints `CATALOG_TRANSFER_JSON=<result>`. Exit codes: 0 done (or unchanged),
 * 1 bad invocation or failure, 2 refused.
 *
 * Env: DATABASE_URL (required).
 */

import 'dotenv/config';

import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  CatalogTransferError,
  parseTransferCatalogArgv,
  transferCapabilityCatalogOwnership,
} from '../src/services/capabilityCatalogTransfer.service';
import { logger } from '../src/utils/logger';

const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

async function main(): Promise<void> {
  let invocation: ReturnType<typeof parseTransferCatalogArgv>;
  try {
    invocation = parseTransferCatalogArgv(process.argv.slice(2));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_FAILED);
  }
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(EXIT_FAILED);
  }
  await connectPostgres();
  try {
    const result = await transferCapabilityCatalogOwnership(invocation);
    process.stdout.write(`CATALOG_TRANSFER_JSON=${JSON.stringify(result)}\n`);
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof CatalogTransferError) {
      logger.error(`Refused (${error.reason}): ${error.message}`);
      process.exit(EXIT_REFUSED);
    }
    logger.error(
      'Capability catalog transfer failed',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'transfer-capability-catalog', method: 'main' },
    );
    process.exit(EXIT_FAILED);
  });
}
