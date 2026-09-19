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
 * A binding is first a statement of IDENTITY: "this IAM role is Mention". With
 * `--scopes` it also names the authority the mint gives that identity — exactly
 * as a service credential's scopes do, and bounded the same way:
 *
 *   * The application's own grants are the ceiling. A binding can never name a
 *     scope the application was not granted; the mint intersects the two at
 *     every issue, so losing it on the application loses it here too.
 *   * A PRIVILEGED scope may be named, because this row is a deliberate human
 *     act — staff wrote it, it names one role and one application, and it
 *     carries a description somebody typed. What still cannot name one is the
 *     attestation: it selects a binding, it never decides what a binding says.
 *   * Naming no scopes is what every binding written before this flag existed
 *     says, and it still means the application's non-privileged grants.
 *
 * Running this script IS the staff check `isStaffUser` performs on a route:
 * there is no route, and the entry fee is a terminal with this environment's
 * `DATABASE_URL`. The service gate takes that as an explicit claim rather than
 * a default (see `WorkloadBindingActor`), so a future caller that has an actual
 * actor to check must say so and fails closed if it does not.
 *
 * The environment is still the DEPLOYMENT's — an attestation cannot ask for
 * one, so a staging workload can never mint a production token.
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
 *     [--scopes federation:write,signals:write,catalogs:write] \
 *     [--expires-at 2026-12-31T00:00:00Z]
 *
 *   bun run packages/api/scripts/bind-workload-identity.ts --app-id <id> --list
 *
 * `--scopes` takes a comma-separated list. OMITTING it leaves an existing
 * binding's scopes exactly as they are — the deploy step that re-runs this
 * command was written before the flag existed and must not revoke what it never
 * mentioned. `--scopes=` (empty) is the explicit way to say "name none".
 *
 * Re-running with the SAME scopes is a no-op that reports `unchanged`; running
 * with different ones reports `updated` and says which scopes moved. Both exit
 * 0 — a bind is a deploy step and a deploy step that already happened is not a
 * failure.
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

  const result = await bindWorkloadIdentity({
    ...invocation.request,
    /**
     * The staff claim, stated rather than defaulted.
     *
     * Reaching this line means holding this environment's `DATABASE_URL` and
     * running a one-off task against it, which is the access `isStaffUser`
     * stands in for on a route. The gate refuses a privileged scope when the
     * claim is absent, so the value of writing it here is that the NEXT caller
     * — a Console surface, a deploy job, an agent — has to write its own and
     * cannot inherit this one by omission.
     */
    actor: { isPlatformStaff: true, describedAs: 'an operator with direct database access' },
  });
  if (result.changed) {
    // The only feedback a one-off ECS task gives is what it prints, and "the
    // bind succeeded" is not an answer to "did my scopes land?".
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
