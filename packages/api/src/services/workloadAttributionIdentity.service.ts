import { eq } from 'drizzle-orm';

import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { workloadTokenEnvironment } from '../utils/credentialEnvironment';
import { workloadAttestationHandle } from './workloadAttestation.service';

/**
 * The row an ATTESTED identity spends against.
 *
 * ## The problem, exactly
 *
 * ADR 0026's attested caller authenticates correctly — the binding is found, the
 * application is trusted, the scopes are live — and then dies in the usage
 * ledger:
 *
 *     insert or update on table "usage_reservations" violates foreign key
 *     constraint "usage_reservations_application_credential_id_application_creden"
 *     params: …, wl_fc88a3bd231e32064442869d, …
 *
 * Four tables record the identity that authorised a spend in
 * `application_credential_id`, `NOT NULL`, with a foreign key to
 * `application_credentials.id`: `usage_reservations` and `usage_receipts`
 * (`RESTRICT`), `inference_usage_events` and `inference_usage_daily_rollups`
 * (`CASCADE`, and on the rollups it is part of the PRIMARY KEY, which rules out
 * making it nullable). An attested identity is a `wl_…` handle naming a binding,
 * so there was no row for it to reference and the inference edge refused
 * `proof === 'workload'` outright rather than failing that constraint
 * mid-request.
 *
 * Dropping the four constraints was prototyped, reverted and escalated.
 * `db/MIGRATION-CONTRACT.md` records the answer: "no quiero perder los vínculos
 * relacionales de nada". These are financial tables and the constraints carry
 * decided behaviour — `RESTRICT` means a credential with spend against it cannot
 * be deleted at all, `CASCADE` means a deleted one takes its usage detail with
 * it. So the link stays and the missing ROW is what gets built.
 *
 * ## What this module does
 *
 * It materialises a binding as a `workload`-typed `application_credentials` row
 * whose `id` IS the attestation handle. The handle is already a stable identifier
 * derived from the canonical role ARN and from nothing else
 * (`workloadAttestation.service.ts`), so the row makes it what it was already
 * doing in practice: naming the thing that authorised the spend. Every foreign
 * key, cascade, join and usage report downstream then needs no change at all —
 * which is the entire argument for this shape over a sibling table the four
 * columns would have had to be repointed at, PRIMARY KEY included.
 *
 * A workload row is not a credential and cannot be presented as one. That is
 * four CHECK constraints rather than a convention; the reasoning is in
 * `db/schema/applicationCredentials.ts`'s header, and the short version is that
 * it has no `public_key`, so the six lanes that resolve an OAuth `client_id`
 * cannot match it, and no `secret_hash`, so the three that verify a secret have
 * nothing to compare.
 *
 * ## This module is the ONLY writer
 *
 * Two callers, and both are deliberate:
 *
 *   * `workloadIdentityBinding.service.ts`, in the same transaction as the
 *     binding insert — so the operator who runs `bind-workload-identity.ts` has
 *     the row the moment the binding exists, and a binding written through the
 *     service can never lack one.
 *   * `workloadIdentity.service.ts`, before the token is minted — the single
 *     point at which a `wl_…` `credentialId` enters circulation. That makes "a
 *     token naming a handle has a row the ledger can reference" a precondition of
 *     issuing the token rather than a hope about the past, and it is why the
 *     thirteen bindings already live in production need no backfill: their next
 *     mint writes the row. A mint happens once an hour per task, so the cost is
 *     one indexed probe against a table the same request already reads.
 */

/** Why a materialisation was refused. */
export type WorkloadAttributionRefusal = 'attributed_elsewhere';

export class WorkloadAttributionError extends Error {
  readonly reason: WorkloadAttributionRefusal;
  constructor(reason: WorkloadAttributionRefusal, message: string) {
    super(message);
    this.name = 'WorkloadAttributionError';
    this.reason = reason;
  }
}

export interface WorkloadAttributionIdentity {
  /** The handle — what a minted token carries and what the ledger references. */
  readonly credentialId: string;
  readonly state: 'created' | 'relinked' | 'unchanged';
}

export interface EnsureWorkloadAttributionInput {
  /** The `application_workload_identities` row being materialised. */
  readonly bindingId: string;
  readonly applicationId: string;
  /** The CANONICAL subject — the same string the binding row stores. */
  readonly subject: string;
}

/**
 * Makes sure the attested identity for `subject` has a row the ledger can name,
 * and that it points at the binding that currently authorises it.
 *
 * Idempotent, and safe to call on every mint. The three states are for the log
 * and for a test: `created` on first sight, `relinked` when the subject was
 * unbound and bound again (its ledger history is reattached to the new binding
 * row), `unchanged` otherwise.
 *
 * ## The one refusal
 *
 * A row already naming a DIFFERENT application is refused. The handle derives
 * from the subject alone, so this is the case where a role that has spent money
 * as one application is being bound to another: relinking would attribute that
 * application's spend to the first one's identity, and rewriting the row's
 * `application_id` would relabel history. Neither is acceptable, and the honest
 * answer to an operator moving a role between applications is that the role
 * cannot follow — a new role can.
 *
 * ## Why no `status`, `expires_at` or scope bookkeeping
 *
 * None of them is read for a workload row. Liveness is the binding's, re-read on
 * every call by `resolveLiveAgencyWorkloadByHandle`; authority is the binding's,
 * decided by `workloadBindingScopes`. The row records WHICH identity spent, and
 * a second copy of a mutable fact here would be a second answer that drifts. The
 * inert CHECK holds `scopes` empty for exactly that reason.
 */
export async function ensureWorkloadAttributionIdentity(
  input: EnsureWorkloadAttributionInput,
  db: DatabaseOrTransaction = getDb()
): Promise<WorkloadAttributionIdentity> {
  const credentialId = workloadAttestationHandle(input.subject);

  const reconciled = await reconcileExistingRow(credentialId, input, db);
  if (reconciled) return reconciled;

  const inserted = await db
    .insert(applicationCredentials)
    .values({
      id: credentialId,
      applicationId: input.applicationId,
      /**
       * The role ARN, for whoever reads this table. It is not compared against
       * anything — the `id` is the identity — so an operator renaming the row
       * breaks nothing. Nor is it a disclosure: the binding row beside it stores
       * the same string, and `bind-workload-identity.ts` prints it.
       */
      name: input.subject,
      /**
       * NULL, and the CHECK requires it. This is what makes the row unusable as
       * an OAuth client on the six lanes that look one up by `public_key`.
       */
      publicKey: null,
      type: 'workload',
      /**
       * The DEPLOYMENT's environment, from the one definition the mint and the
       * live re-read already share. A workload proves what it is, never which
       * environment it means, so there is no third opinion to have here.
       */
      environment: workloadTokenEnvironment(),
      scopes: [],
      workloadIdentityId: input.bindingId,
    })
    // Two tasks of the same service can mint concurrently and both read "no
    // row". The primary key decides it, and the loser reconciles against
    // whatever the winner wrote rather than reporting a database error — which
    // matters because the winner is not guaranteed to have written the same
    // thing: a concurrent re-bind of the same subject to another application
    // reaches the refusal below instead of silently succeeding.
    .onConflictDoNothing({ target: applicationCredentials.id })
    .returning({ id: applicationCredentials.id });

  if (inserted.length > 0) return { credentialId, state: 'created' };

  const raced = await reconcileExistingRow(credentialId, input, db);
  if (raced) return raced;
  // The conflict said a row exists and the re-read says it does not, which only
  // a concurrent delete can produce. Reporting it beats looping.
  throw new WorkloadAttributionError(
    'attributed_elsewhere',
    `The attested identity ${credentialId} was removed while it was being materialised.`
  );
}

/**
 * The existing-row half of {@link ensureWorkloadAttributionIdentity}, shared by
 * the first read and the post-conflict one so a race cannot take a different
 * decision from the common path.
 */
async function reconcileExistingRow(
  credentialId: string,
  input: EnsureWorkloadAttributionInput,
  db: DatabaseOrTransaction
): Promise<WorkloadAttributionIdentity | null> {
  const [existing] = await db
    .select({
      applicationId: applicationCredentials.applicationId,
      workloadIdentityId: applicationCredentials.workloadIdentityId,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, credentialId))
    .limit(1);

  if (!existing) return null;

  if (existing.applicationId !== input.applicationId) {
    throw new WorkloadAttributionError(
      'attributed_elsewhere',
      `The attested identity ${credentialId} already records spend for application ` +
        `${existing.applicationId}; refusing to re-attribute it to ${input.applicationId}. ` +
        'Ledger history names the identity that authorised it, and an identity cannot change ' +
        'which application it spent as. Give the new application its own role.'
    );
  }
  if (existing.workloadIdentityId === input.bindingId) {
    return { credentialId, state: 'unchanged' };
  }
  await db
    .update(applicationCredentials)
    .set({ workloadIdentityId: input.bindingId })
    .where(eq(applicationCredentials.id, credentialId));
  return { credentialId, state: 'relinked' };
}
