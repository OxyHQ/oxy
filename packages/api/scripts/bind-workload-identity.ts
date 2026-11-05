#!/usr/bin/env bun
/**
 * Provision a staff-managed workload identity. The environment is explicit and
 * cannot be changed on an existing binding. Re-running the same request is safe.
 *
 * bun run packages/api/scripts/bind-workload-identity.ts \
 *   --app-id <id> --role-arn <arn> --environment production
 * bun run packages/api/scripts/bind-workload-identity.ts --app-id <id> --list
 *
 * Env: DATABASE_URL. Exit: 0 done, 1 invalid invocation/fault, 2 refused.
 */

import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  type BindWorkloadIdentityInvocation,
  bindWorkloadIdentity,
  listWorkloadIdentityBindings,
  parseBindWorkloadIdentityArgv,
  WorkloadBindingError,
  WorkloadBindingUsageError,
} from '../src/services/workloadIdentityBinding.service';
import { logger } from '../src/utils/logger';

/** Exit codes, named so the two failure kinds cannot be confused at a glance. */
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

function emit(payload: unknown): void {
  process.stdout.write(`WORKLOAD_BINDING_JSON=${JSON.stringify(payload)}\n`);
}

async function run(invocation: BindWorkloadIdentityInvocation): Promise<void> {
  if (invocation.mode === 'list') {
    const bindings = await listWorkloadIdentityBindings(invocation.applicationId);
    emit({ mode: 'list', applicationId: invocation.applicationId, bindings });
    return;
  }

  const result = await bindWorkloadIdentity({
    ...invocation.request,
    /**
     * The staff claim, stated rather than defaulted.
     *
     * Reaching this line means holding this environment's `DATABASE_URL` and
     * running a one-off task against it, which is the access `isStaffUser`
     * stands in for on a route. The gate refuses provisioning when the
     * claim is absent, so the value of writing it here is that the NEXT caller
     * — a Console surface, a deploy job, an agent — has to write its own and
     * cannot inherit this one by omission.
     */
    actor: { isPlatformStaff: true, describedAs: 'an operator with direct database access' },
  });
  if (result.changed) {
    // The only feedback a one-off ECS task gives is what it prints, and "the
    // bind succeeded" is not an answer to "was the environment bound?".
    logger.info('[BindWorkloadIdentity] the existing binding was UPDATED', {
      applicationId: result.binding.applicationId,
      changed: result.changed,
    });
  }
  if (result.ignoredChanges) {
    // Reported, never applied: a create that quietly became an edit is how an
    // expiry gets set on a row nobody meant to change.
    logger.warn(
      '[BindWorkloadIdentity] the existing binding was NOT modified; re-running does not edit',
      { applicationId: result.binding.applicationId, ignoredChanges: result.ignoredChanges },
    );
  }
  // `attestationId` rides along inside `result.binding`; named again here
  // because it is the one value somebody reading this output has come to get.
  logger.info('[BindWorkloadIdentity] tokens from this binding will carry', {
    credentialId: result.binding.attestationId,
    authority: 'first_party',
    environment: result.binding.environment,
  });
  emit({ mode: 'bind', ...result });
}

async function main(): Promise<void> {
  // Argv first: a malformed invocation should not open a database connection to
  // find that out, and the operator gets the usage error in the same second
  // rather than after a connect timeout against the wrong DATABASE_URL.
  const invocation = parseBindWorkloadIdentityArgv(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(EXIT_FAILED);
  }

  await connectPostgres();
  try {
    await run(invocation);
  } finally {
    await closePostgres();
  }
}

/**
 * Guarded so importing this file does nothing.
 *
 * The decisions are in `services/workloadIdentityBinding.service.ts` precisely
 * so they can be tested; a module that connects to Postgres on import cannot be.
 */
if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof WorkloadBindingUsageError) {
      logger.error(error.message);
      process.exit(EXIT_FAILED);
    }
    if (error instanceof WorkloadBindingError) {
      logger.error(`Refused (${error.reason}): ${error.message}`);
      process.exit(EXIT_REFUSED);
    }
    logger.error(
      'Workload identity binding failed',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'bind-workload-identity', method: 'main' },
    );
    process.exit(EXIT_FAILED);
  });
}
