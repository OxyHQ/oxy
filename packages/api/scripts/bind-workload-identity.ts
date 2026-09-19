#!/usr/bin/env bun
/**
 * Bind a workload identity to an Oxy application — the one manual step of the
 * credential-free service auth in ADR 0026.
 *
 * ADR 0026 shipped whole except for this: a first-party service signs an STS
 * `GetCallerIdentity` request, Oxy replays it, AWS says which IAM role signed
 * it, and `application_workload_identities` answers "which application is that
 * role?". Nothing created rows in that table — no route, no script, no
 * procedure — so every attestation reached `unbound_workload` and no service
 * could actually be moved off its shared secret. This is that missing step.
 *
 * ## What it grants, and what it does not
 *
 * A binding is a statement of IDENTITY: "this IAM role is Mention". It grants
 * no authority of its own. The token the mint later issues carries the
 * application's own non-privileged scopes and the DEPLOYMENT's environment, so
 * a binding can never widen what an application may do, never reach a
 * privileged scope, and never make a staging workload production.
 *
 * ## Nothing here is a secret
 *
 * Unlike `create-service-credential.ts`, which encrypts its output because it
 * emits a one-time secret, this script emits an account number, a role name and
 * an application id. None of them authenticates anybody: possession of the row
 * is worthless without possession of the IAM role it names, which is exactly
 * why ADR 0026 prefers this to a shared secret. The output is safe in a CI log.
 *
 * Usage:
 *   bun run packages/api/scripts/bind-workload-identity.ts \
 *     --app-id <application id> \
 *     --role-arn arn:aws:iam::237343248947:role/oxy-mention-task \
 *     [--provider aws-iam] [--description "Mention ECS task role"] \
 *     [--expires-at 2026-12-31T00:00:00Z]
 *
 *   bun run packages/api/scripts/bind-workload-identity.ts --app-id <id> --list
 *
 * `--role-arn` also accepts the `arn:aws:sts::…:assumed-role/<role>/<session>`
 * form a running task reports; it is canonicalised by the same function the
 * verifier uses, so what is stored is what an attestation will present.
 *
 * Exit codes: 0 done, 1 bad invocation or unexpected failure, 2 refused.
 *
 * Env: DATABASE_URL (required).
 */

import 'dotenv/config';

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

  const result = await bindWorkloadIdentity(invocation.request);
  if (result.ignoredChanges) {
    // Reported, never applied: a create that quietly became an edit is how an
    // expiry gets set on a row nobody meant to change.
    logger.warn(
      '[BindWorkloadIdentity] the existing binding was NOT modified; re-running does not edit',
      { applicationId: result.binding.applicationId, ignoredChanges: result.ignoredChanges },
    );
  }
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
