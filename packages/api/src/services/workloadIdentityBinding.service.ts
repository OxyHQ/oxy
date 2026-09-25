import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import {
  isPrivilegedScope,
  isValidApplicationScope,
  type ApplicationScope,
} from '../utils/applicationScopes';
import { logger } from '../utils/logger';
import { isTrustedApplication } from '../utils/trustedApplication';
import {
  canonicalAwsSubject,
  isAttestationProvider,
  workloadAttestationHandle,
  type AttestationProvider,
} from './workloadAttestation.service';
import {
  ensureWorkloadAttributionIdentity,
  WorkloadAttributionError,
} from './workloadAttributionIdentity.service';

/**
 * Creating the row that makes a workload an application — the one write on the
 * credential-free path, and the only step of ADR 0026 a human performs.
 *
 * `workloadIdentity.service.ts` reads `application_workload_identities` to
 * answer "which application is this attested workload?". Nothing wrote it.
 * Every other piece of ADR 0026 shipped — the challenge, the STS verifier, the
 * mint, the trust and scope gates — so the path was complete except that the
 * table it resolves against was empty and stayed empty, and every attestation
 * ended at `unbound_workload`. This module is that missing write, and the
 * refusals around it.
 *
 * ## Why this is a module and not a route
 *
 * A binding says one service IS one application. Exposing that over HTTP means
 * designing who may call it, and the honest answer — staff, out of band, once
 * per service deployment — is an operator task, not a product surface. It is
 * also rare: a row per service, created when that service is deployed and
 * deleted when it is retired. `scripts/bind-workload-identity.ts` is the
 * entrypoint; the decisions live here so they can be tested without a process.
 *
 * ## A binding names identity, and — since the scopes column — authority too
 *
 * For as long as this module existed, a binding said only WHICH application a
 * workload is, and the mint gave that application's non-privileged grants. That
 * made every first-party service holding a privileged scope unmigratable: take
 * the key pair off Mention's task definition and `federation:write`,
 * `signals:write` and `catalogs:write` go with it, which is what happened in
 * production and what the scopes column fixes.
 *
 * The fix is not a weaker rule. The rule is that privileged authority must be
 * named on something a human granted deliberately, and a binding row IS such a
 * thing: staff write it, it names one IAM role and one application, and it
 * carries a description somebody wrote. So it may name scopes exactly as an
 * `ApplicationCredential` may, and {@link authorizeBindingScopes} applies the
 * same gate `POST /applications/:appId/credentials` applies — the app's grants
 * are the ceiling for everyone, and a privileged scope needs staff.
 *
 * ## There is no secret here, and that is the point
 *
 * `create-service-credential.ts` encrypts its output because it emits a secret
 * exactly once. This module emits nothing of the kind: a binding row is a
 * statement about our own infrastructure — an account number, a role name, an
 * application id — and none of it authenticates anybody on its own. Holding the
 * row's contents gets an attacker nowhere without also holding the IAM role it
 * names, which is the whole reason ADR 0026 prefers this to a shared secret. So
 * the output of a bind is safe to paste into a ticket, a CI log or a runbook,
 * and no part of this file needs to be careful about what it prints.
 */

/** Why a bind was refused. Every value is a deliberate no, never a failure. */
export type WorkloadBindingRefusal =
  | 'unsupported_provider'
  | 'uncanonical_subject'
  | 'unknown_application'
  | 'application_inactive'
  | 'untrusted_application'
  | 'invalid_expiry'
  | 'subject_bound_elsewhere'
  | 'subject_attributed_elsewhere'
  | 'unknown_scope'
  | 'ungrantable_scope'
  | 'privileged_scope_requires_staff';

export class WorkloadBindingError extends Error {
  readonly reason: WorkloadBindingRefusal;
  constructor(reason: WorkloadBindingRefusal, message: string) {
    super(message);
    this.name = 'WorkloadBindingError';
    this.reason = reason;
  }
}

export interface WorkloadBindingRow {
  id: string;
  applicationId: string;
  provider: string;
  subject: string;
  description: string | null;
  /** What the mint will intersect with the application's grants. Empty means "names none". */
  scopes: string[];
  /**
   * The `credentialId` every token minted through this binding will carry.
   *
   * Derived, not stored: it is a function of the subject and nothing else
   * ({@link workloadAttestationHandle}), so storing it would be a second copy
   * of a value the mint recomputes on every issue. Reported because an operator
   * otherwise has no way to learn it — a consumer that pins the claim (Homiio,
   * Clarity) would have to capture a live token to read it out, which is a
   * worse way to obtain a value than being told it at bind time.
   */
  attestationId: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Who is asking, for the privileged-scope gate.
 *
 * The application routes ask `isStaffUser(req)`. There is no request here and
 * no route — a bind is an operator at a terminal with this environment's
 * `DATABASE_URL` — so the caller states the same fact instead, and the gate
 * reads it the same way.
 *
 * ABSENT MEANS NOT STAFF, deliberately. The one thing this field must never do
 * is default to "yes" for a caller that never considered the question: today
 * the only caller is the script, where the operator IS the staff check that
 * `isStaffUser` performs on a route, and stating it explicitly is what makes
 * the next caller — a Console surface, a deploy job, an agent — fail closed
 * instead of inheriting authority it never asked for.
 */
export interface WorkloadBindingActor {
  /** True when this actor passes the same check `isStaffUser` applies. */
  isPlatformStaff: boolean;
  /** How the actor is named in a refusal and in the log line. */
  describedAs: string;
}

export interface WorkloadBindingRequest {
  applicationId: string;
  /** Defaults to the only provider with a verifier today. */
  provider?: string;
  /** A role ARN, or the assumed-role ARN a task reports — both canonicalise. */
  subject: string;
  description?: string;
  /**
   * Scopes the binding names, or ABSENT to leave whatever the row already says.
   *
   * Absent and `[]` are different answers on purpose. A bind runs as part of a
   * deploy and will be re-run with whatever arguments that deploy step has
   * always carried, which for every existing service is no scopes at all — so
   * absent MUST mean "do not touch", or the first re-run after a migration
   * silently revokes the authority the migration just granted. Naming an empty
   * list is the explicit way to say "this binding names none", and it is
   * applied.
   */
  scopes?: readonly string[];
  /** ISO 8601. Absent means the binding does not wind itself down. */
  expiresAt?: string;
  /** Required before a privileged scope can be named; see {@link WorkloadBindingActor}. */
  actor?: WorkloadBindingActor;
}

export interface WorkloadBindingResult {
  /**
   * `created` wrote a row, `updated` changed the scopes of one already there,
   * and `unchanged` found the binding already saying what was asked for.
   */
  state: 'created' | 'unchanged' | 'updated';
  binding: WorkloadBindingRow;
  /**
   * What `updated` changed, named for the operator, and absent otherwise.
   *
   * The only feedback a one-off ECS task gives is what it prints, so a run that
   * moved a binding from no scopes to three says which three, and a run that
   * moved nothing says `unchanged` rather than the same cheerful success.
   */
  changed?: string[];
  /**
   * Set on `unchanged` when the run asked for a description or expiry that
   * differs from the stored row.
   *
   * An idempotent bind does not edit, so a second run with new arguments would
   * otherwise report success while changing nothing — the operator walks away
   * believing an expiry was set. Naming the drift is what stops that; changing
   * an existing binding is a deliberate act against the row, not a side effect
   * of re-running a create.
   */
  ignoredChanges?: string[];
}

/**
 * Add the derived handle to a row on its way out.
 *
 * One function rather than a spread at each call site, so a path that forgets it
 * is a type error rather than a row that silently reports no handle.
 */
function withAttestationId(row: Omit<WorkloadBindingRow, 'attestationId'>): WorkloadBindingRow {
  return { ...row, attestationId: workloadAttestationHandle(row.subject) };
}

const BINDING_COLUMNS = {
  id: applicationWorkloadIdentities.id,
  applicationId: applicationWorkloadIdentities.applicationId,
  provider: applicationWorkloadIdentities.provider,
  subject: applicationWorkloadIdentities.subject,
  description: applicationWorkloadIdentities.description,
  scopes: applicationWorkloadIdentities.scopes,
  expiresAt: applicationWorkloadIdentities.expiresAt,
  createdAt: applicationWorkloadIdentities.createdAt,
} as const;

/**
 * The shape `canonicalAwsSubject` produces from a real attestation, and the only
 * shape a binding may store.
 *
 * Deliberately as permissive about the partition and the account as
 * `canonicalAwsSubject` itself: this asserts the RESULT, it does not re-decide
 * it. A stricter pattern would refuse a subject the verifier can genuinely
 * present, which is the same dead binding reached from the opposite side.
 */
const CANONICAL_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d+:role\/[^/]+$/;

/**
 * Reduce an operator-supplied subject to the exact string an attestation will
 * present, using the verifier's own function rather than a second copy of it.
 *
 * The duplicate is the bug worth designing against. A canonicaliser written here
 * would agree with `canonicalAwsSubject` on the day it was written and drift the
 * first time either side learned about a partition or a new ARN shape. Two rules
 * that must agree, and only agree by inspection, produce a binding that looks
 * correct in the table and never matches at mint time — a failure with no error
 * message anywhere near its cause. So the reduction is imported; all that
 * happens here is a check that what came back is a role ARN.
 *
 * That check is needed because the verifier's reduction PASSES THROUGH anything
 * it does not recognise — correctly, since inventing a transformation for an
 * unseen shape is how a subject silently becomes a different subject. Pass-
 * through is the right answer for a verifier reporting what AWS said. It is the
 * wrong answer for an operator typing at a terminal, where the unrecognised
 * shape is a typo, a user ARN, or a role ARN carrying an IAM path — and each of
 * them would be written happily and never match anything:
 *
 *   * **A role ARN with a path** (`…:role/service/oxy-mention`). An assumed-role
 *     ARN drops the path, so the verifier can only ever present the pathless
 *     form. The binding must be written that way too — which is the caveat
 *     `canonicalAwsSubject` documents, enforced here rather than left to be read.
 *   * **An IAM user, the account root, a federated user.** All of them imply a
 *     long-lived secret or a human, which is the thing ADR 0026 removes.
 *   * **Anything that is not an ARN.** A mistyped subject is a binding that
 *     exists, reads as done, and authenticates nobody.
 */
export function canonicalWorkloadSubject(provider: AttestationProvider, subject: string): string {
  const trimmed = subject.trim();
  if (provider === 'aws-iam') {
    const canonical = canonicalAwsSubject(trimmed);
    if (!CANONICAL_ROLE_ARN.test(canonical)) {
      throw new WorkloadBindingError(
        'uncanonical_subject',
        `"${trimmed}" is not an AWS identity a workload can be bound to. Supply an IAM role ARN ` +
          '(arn:aws:iam::<account>:role/<role>) or the assumed-role ARN a task reports. A role ' +
          'with an IAM path must be given without it: the ARN STS reports omits the path, so the ' +
          'pathless form is the only one an attestation can ever present.',
      );
    }
    return canonical;
  }
  return trimmed;
}

/** Narrow the provider against the closed set of verifiers that exist. */
function requireProvider(value: string): AttestationProvider {
  if (!isAttestationProvider(value)) {
    throw new WorkloadBindingError(
      'unsupported_provider',
      `No verifier exists for provider "${value}", so a binding under it could never be used. ` +
        'Implement an AttestationVerifier first.',
    );
  }
  return value;
}

/**
 * Resolve the application an operator named, by its exact opaque id.
 *
 * Shared by bind and list, so a mistyped id is a refusal on both — a read that
 * answers "no bindings" for an id that does not exist is the reading that gets
 * a second, duplicate binding created under the id somebody meant.
 */
async function requireApplication(applicationId: string) {
  const [application] = await getDb()
    .select({
      id: applications.id,
      name: applications.name,
      status: applications.status,
      scopes: applications.scopes,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!application) {
    throw new WorkloadBindingError(
      'unknown_application',
      `No application has id "${applicationId}". Application ids are opaque — a near miss is ` +
        'somebody else, so nothing is guessed from it.',
    );
  }
  return application;
}

/**
 * The staff-only privileged-scope gate, and the application ceiling — the same
 * rules `POST /applications/:appId/credentials` applies, restated for a caller
 * that has no `req` to ask `isStaffUser` about.
 *
 * Three rules, in the order the route applies them:
 *
 *   1. **A scope must exist.** The route gets this from its request schema; a
 *      script gets a string an operator typed. A misspelt scope written here
 *      would sit in the table reading as granted while the mint silently drops
 *      it, and the failure would surface as a 403 from another service with
 *      nothing pointing back at this row.
 *   2. **The application's grants are the ceiling, for everyone including
 *      staff.** A binding must never name a scope the application itself was
 *      not granted — that is the invariant `intersectScopes` enforces at every
 *      mint, and refusing the write as well is what stops a row from reading as
 *      a finished rollout that quietly grants less than it says. Staff get no
 *      exemption here for the same reason they get none on the route: widening
 *      an APPLICATION's authority is a separate, deliberate act on the
 *      application record.
 *   3. **A privileged scope requires staff**, and so does taking one away.
 *
 * Rule 3 is symmetric because the route's is (`authorizeRequestedScopes`,
 * `routes/applications.ts`), and for the failure that made it symmetric: a
 * caller that omits an already-granted privileged scope would otherwise REVOKE
 * it by omission, which is exactly how Mention's in-use `signals:write` was
 * wiped by routine edits. A bind is re-run by a deploy step whose arguments
 * predate the scope it is now carrying, so omission-as-revocation is not a
 * hypothetical here — it is the default shape of the second run. An omitted
 * privileged scope is therefore PRESERVED and said out loud, never dropped.
 *
 * `previousScopes` is empty on create and the stored row's scopes on update.
 */
export function authorizeBindingScopes(
  requested: readonly string[],
  applicationScopes: readonly string[],
  previousScopes: readonly string[],
  actor: WorkloadBindingActor | undefined,
): ApplicationScope[] {
  const deduped: ApplicationScope[] = [];
  const seen = new Set<string>();
  for (const scope of requested) {
    const trimmed = scope.trim();
    if (!isValidApplicationScope(trimmed)) {
      throw new WorkloadBindingError(
        'unknown_scope',
        `"${trimmed}" is not an Oxy application scope, so a binding naming it would grant ` +
          'nothing and read as if it granted something. Check the spelling against ' +
          'APPLICATION_SCOPES in utils/applicationScopes.ts.',
      );
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }

  const grantable = new Set(applicationScopes);
  const ungrantable = deduped.filter((scope) => !grantable.has(scope));
  if (ungrantable.length > 0) {
    throw new WorkloadBindingError(
      'ungrantable_scope',
      `Scope(s) [${ungrantable.join(', ')}] are not granted to this application, so the mint ` +
        'would drop them from every token and the binding would read as granting authority it ' +
        'cannot. Grant them on the application first — a deliberate act on the application ' +
        'record, with its own staff gate.',
    );
  }

  if (actor?.isPlatformStaff) return deduped;

  const previouslyGranted = new Set(previousScopes);
  const newlyAddedPrivileged = deduped.filter(
    (scope) => isPrivilegedScope(scope) && !previouslyGranted.has(scope),
  );
  if (newlyAddedPrivileged.length > 0) {
    throw new WorkloadBindingError(
      'privileged_scope_requires_staff',
      `Naming the scope(s) [${newlyAddedPrivileged.join(', ')}] on a binding requires Oxy ` +
        `platform staff privileges; this bind is running as ${actor?.describedAs ?? 'an unidentified actor'}. ` +
        'A binding can name privileged authority precisely because a human wrote the row — so ' +
        'the row has to be written by one.',
    );
  }

  // Preserve, never silently revoke: an omitted privileged scope is a deploy
  // step re-running with the arguments it has always had, not a decision.
  const preserved = Array.from(previouslyGranted).filter(
    (scope): scope is ApplicationScope =>
      isPrivilegedScope(scope) && !seen.has(scope) && isValidApplicationScope(scope),
  );
  if (preserved.length > 0) {
    logger.warn(
      '[WorkloadIdentityBinding] preserving a privileged scope the bind omitted; removing one requires staff',
      { scopes: preserved, actor: actor?.describedAs ?? 'unidentified' },
    );
  }
  return [...deduped, ...preserved];
}

function requireExpiry(value: string | undefined, now: Date): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new WorkloadBindingError(
      'invalid_expiry',
      `"${value}" is not a date. Use ISO 8601, e.g. 2026-12-31T00:00:00Z.`,
    );
  }
  if (parsed <= now) {
    throw new WorkloadBindingError(
      'invalid_expiry',
      `An expiry of ${parsed.toISOString()} is already past, so the binding would never work. ` +
        'Delete a binding to cut a workload off now; an expiry is for winding one down later.',
    );
  }
  return parsed;
}

function describeDrift(
  existing: WorkloadBindingRow,
  description: string | undefined,
  expiresAt: Date | null,
): string[] {
  const drift: string[] = [];
  if (description !== undefined && description !== existing.description) {
    drift.push(`description (stored: ${existing.description ?? 'none'})`);
  }
  const storedExpiry = existing.expiresAt?.toISOString() ?? null;
  const requestedExpiry = expiresAt?.toISOString() ?? null;
  if (requestedExpiry !== null && requestedExpiry !== storedExpiry) {
    drift.push(`expiresAt (stored: ${storedExpiry ?? 'none'})`);
  }
  return drift;
}

async function findBinding(
  provider: AttestationProvider,
  subject: string,
): Promise<WorkloadBindingRow | undefined> {
  const [row] = await getDb()
    .select(BINDING_COLUMNS)
    .from(applicationWorkloadIdentities)
    .where(
      and(
        eq(applicationWorkloadIdentities.provider, provider),
        eq(applicationWorkloadIdentities.subject, subject),
      ),
    )
    .limit(1);
  return row ? withAttestationId(row) : undefined;
}

/**
 * Decide what an existing row means for this request.
 *
 * Same application: the bind already happened, and re-running a deploy step
 * must not be an error. Different application: REFUSE, and never repoint. A
 * repoint is silent and total — the workload keeps authenticating, keeps
 * getting tokens, and every one of them now carries somebody else's
 * `applicationId`, so its writes land in another tenant's data with correct
 * audit attribution to the wrong party. There is no reading of "bind this role
 * to this app" that should quietly take a role away from the app that has it;
 * an operator who genuinely means to move one deletes the old row first, which
 * is a decision with its own trace.
 *
 * ## Scopes ARE applied, and the asymmetry with description and expiry is the point
 *
 * A re-run still refuses to edit a description or an expiry: it says what it
 * ignored and changes nothing, because a create that quietly became an edit is
 * how a binding's LIFETIME gets changed by somebody who meant to create one.
 *
 * Scopes are the opposite case. Naming them on an existing binding is the whole
 * migration — every service that holds a privileged credential today already
 * has a binding row, and the step that lets it give the key pair up is adding
 * scopes to that row. The only alternative under a no-edit rule is delete and
 * re-create, which cuts a running workload off between the two commands. And
 * unlike an expiry, a scope change cannot be a silent widening: it is bounded
 * by the application's own grants and staff-gated
 * ({@link authorizeBindingScopes}), so the dangerous direction is closed before
 * the write is reached.
 */
async function reconcileExisting(
  existing: WorkloadBindingRow,
  request: {
    applicationId: string;
    applicationScopes: readonly string[];
    description?: string;
    scopes?: readonly string[];
    expiresAt: Date | null;
    actor?: WorkloadBindingActor;
  },
): Promise<WorkloadBindingResult> {
  if (existing.applicationId !== request.applicationId) {
    throw new WorkloadBindingError(
      'subject_bound_elsewhere',
      `${existing.provider} subject ${existing.subject} is already bound to application ` +
        `${existing.applicationId}; refusing to repoint it at ${request.applicationId}. ` +
        'Repointing would hand one service another service\'s identity without either noticing. ' +
        'Delete the existing binding first if the move is intended.',
    );
  }

  /**
   * Repair, on the one command an operator actually re-runs.
   *
   * Every binding written before this row existed — the thirteen services already
   * credential-free in production — reaches here on its next deploy-step bind and
   * gets the row the usage ledger needs. It is also how a binding inserted by raw
   * SQL is healed, and it is idempotent, so a re-run that changes nothing else
   * changes nothing here either.
   */
  try {
    await ensureWorkloadAttributionIdentity({
      bindingId: existing.id,
      applicationId: request.applicationId,
      subject: existing.subject,
    });
  } catch (error: unknown) {
    if (error instanceof WorkloadAttributionError) {
      throw new WorkloadBindingError('subject_attributed_elsewhere', error.message);
    }
    throw error;
  }

  const ignoredChanges = describeDrift(existing, request.description, request.expiresAt);
  const base = {
    binding: existing,
    ...(ignoredChanges.length > 0 ? { ignoredChanges } : {}),
  };

  if (request.scopes === undefined) return { state: 'unchanged', ...base };

  const authorized = authorizeBindingScopes(
    request.scopes,
    request.applicationScopes,
    existing.scopes,
    request.actor,
  );
  // Set equality, not list equality: `--scopes a,b` and `--scopes b,a` name the
  // same authority, and an UPDATE that only reorders a column would move
  // `updated_at` and report a change to an operator who made none.
  if (sameScopeSet(authorized, existing.scopes)) return { state: 'unchanged', ...base };

  const [updated] = await getDb()
    .update(applicationWorkloadIdentities)
    .set({ scopes: authorized, updatedAt: new Date() })
    .where(eq(applicationWorkloadIdentities.id, existing.id))
    .returning(BINDING_COLUMNS);

  return {
    state: 'updated',
    binding: withAttestationId(updated),
    changed: [describeScopeChange(existing.scopes, authorized)],
    ...(ignoredChanges.length > 0 ? { ignoredChanges } : {}),
  };
}

/** Two scope lists naming the same authority. */
function sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((scope) => rightSet.has(scope));
}

/** What an operator needs to read back: what went, what arrived, what stands now. */
function describeScopeChange(before: readonly string[], after: readonly string[]): string {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  const added = after.filter((scope) => !beforeSet.has(scope));
  const removed = before.filter((scope) => !afterSet.has(scope));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`+[${added.join(', ')}]`);
  if (removed.length > 0) parts.push(`-[${removed.join(', ')}]`);
  return `scopes ${parts.join(' ')} (now: ${after.length > 0 ? after.join(', ') : 'none'})`;
}

/** Postgres's unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/**
 * Bind a workload identity to an application, idempotently.
 *
 * Every refusal is a `WorkloadBindingError` with a `reason`; anything else is a
 * genuine fault and is left to propagate.
 */
export async function bindWorkloadIdentity(
  request: WorkloadBindingRequest,
  now: Date = new Date(),
): Promise<WorkloadBindingResult> {
  const provider = requireProvider(request.provider ?? 'aws-iam');
  const subject = canonicalWorkloadSubject(provider, request.subject);
  const expiresAt = requireExpiry(request.expiresAt, now);
  const application = await requireApplication(request.applicationId);

  if (application.status !== 'active') {
    throw new WorkloadBindingError(
      'application_inactive',
      `Application "${application.name}" is ${application.status}. The mint refuses a non-active ` +
        'application, so the binding would be written and never usable.',
    );
  }
  if (!isTrustedApplication(application)) {
    throw new WorkloadBindingError(
      'untrusted_application',
      `Application "${application.name}" is not a trusted first-party application. Workload ` +
        'identity attests to infrastructure we run; a third-party application runs where we ' +
        'cannot attest, and the mint re-applies this same gate — so the binding would be written ' +
        'and refused at every use. Third parties keep the credential path.',
    );
  }

  const reconcileAgainst = {
    applicationId: application.id,
    applicationScopes: application.scopes,
    description: request.description,
    scopes: request.scopes,
    expiresAt,
    actor: request.actor,
  };

  const existing = await findBinding(provider, subject);
  if (existing) return reconcileExisting(existing, reconcileAgainst);

  // Nothing to preserve on a create, so the previous set is empty — the same
  // thing `authorizeRequestedScopes` is handed when an application is created.
  const scopes = authorizeBindingScopes(
    request.scopes ?? [],
    application.scopes,
    [],
    request.actor,
  );

  try {
    /**
     * The binding and the row the usage ledger names it by are written together.
     *
     * `application_credential_id` on `usage_reservations`, `usage_receipts`,
     * `inference_usage_events` and `inference_usage_daily_rollups` is `NOT NULL`
     * with a foreign key, so an attested caller can only spend once
     * `workloadAttributionIdentity.service.ts` has materialised this binding as
     * a `workload` row. In one transaction because a binding that exists without
     * that row is a service that authenticates and then fails its first
     * reservation — the exact state ADR 0026 was stuck in.
     */
    const created = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(applicationWorkloadIdentities)
        .values({
          applicationId: application.id,
          provider,
          subject,
          scopes,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(expiresAt !== null ? { expiresAt } : {}),
        })
        .returning(BINDING_COLUMNS);
      await ensureWorkloadAttributionIdentity(
        { bindingId: row.id, applicationId: application.id, subject },
        tx,
      );
      return row;
    });
    return { state: 'created', binding: withAttestationId(created) };
  } catch (error: unknown) {
    /**
     * A subject whose ledger history belongs to another application. Translated
     * into this module's vocabulary rather than propagated, so the script's
     * refusal exit code covers it like every other deliberate no — and it IS the
     * same refusal as `subject_bound_elsewhere` one step later in time: the
     * binding was deleted, so nothing refused the re-point, but the spend it
     * authorised is still on the books under the old application.
     */
    if (error instanceof WorkloadAttributionError) {
      throw new WorkloadBindingError('subject_attributed_elsewhere', error.message);
    }
    /**
     * Two operators binding the same subject at once both read "no row" and
     * both insert. The unique index on `(provider, subject)` — which exists to
     * make "which application is this workload?" unambiguous — decides it, and
     * the loser re-reads rather than reporting a database error: the answer it
     * owes its caller is whatever the row now says, including the refusal when
     * the winner named a different application.
     */
    if (!isUniqueViolation(error)) throw error;
    const raced = await findBinding(provider, subject);
    if (!raced) throw error;
    return reconcileExisting(raced, reconcileAgainst);
  }
}

/**
 * Every binding an application holds, for the operator asking "is this service
 * actually rolled out, and to what?".
 *
 * An unknown application is a refusal rather than an empty list. The two look
 * identical on a terminal, and the wrong one — a mistyped id reading as "this
 * service has no bindings" — is the one that gets a working binding created a
 * second time under an id nobody meant.
 */
export async function listWorkloadIdentityBindings(
  applicationId: string,
): Promise<WorkloadBindingRow[]> {
  await requireApplication(applicationId);
  const rows = await getDb()
    .select(BINDING_COLUMNS)
    .from(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.applicationId, applicationId))
    .orderBy(asc(applicationWorkloadIdentities.provider), asc(applicationWorkloadIdentities.subject));
  return rows.map(withAttestationId);
}

/* ------------------------------------------------------------------ */
/* The command line                                                    */
/* ------------------------------------------------------------------ */

/**
 * A malformed invocation, as distinct from a refusal.
 *
 * The two are different answers and deserve different exit codes: a refusal
 * means the operator asked a clear question and the answer is no, which a
 * pipeline should surface as a decision. A usage error means nobody has yet
 * asked anything, so retrying it unchanged is pointless.
 */
export class WorkloadBindingUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadBindingUsageError';
  }
}

export type BindWorkloadIdentityInvocation =
  | { mode: 'list'; applicationId: string }
  | { mode: 'bind'; request: WorkloadBindingRequest };

const VALUE_FLAGS = [
  '--app-id',
  '--role-arn',
  '--subject',
  '--provider',
  '--description',
  '--scopes',
  '--expires-at',
] as const;

/**
 * `--scopes a,b` → `['a','b']`, and `--scopes=` → `[]`.
 *
 * The empty string is a real answer and not a missing one: it is how an
 * operator says "this binding names none" out loud, which is different from
 * leaving `--scopes` off entirely (leave the row's scopes alone). Whitespace
 * around a comma is forgiven because the list is copied out of a ticket; an
 * empty ELEMENT (`a,,b`, a trailing comma) is not, because it is a typo in a
 * list where a dropped entry is silent.
 */
export function parseScopeList(raw: string): string[] {
  if (raw.trim() === '') return [];
  return raw.split(',').map((scope) => {
    const trimmed = scope.trim();
    if (trimmed === '') {
      throw new WorkloadBindingUsageError(
        `--scopes contains an empty entry ("${raw}"). Give a comma-separated list with no ` +
          'stray commas, or --scopes= to name none.',
      );
    }
    return trimmed;
  });
}

/**
 * Turn argv into one invocation, or refuse to guess.
 *
 * Exported and pure so the command line is testable without a process, a
 * database or a clock. The parsing rules are all one rule — never infer intent
 * from a malformed argument:
 *
 *   * An unrecognised flag is an error, not something to skip. A run that
 *     silently ignores `--expires` because the flag is `--expires-at` creates a
 *     permanent binding while its author believes it wound down on a date.
 *   * `--role-arn` and `--subject` fill the same slot; giving both different
 *     values means the operator does not know which one is being bound.
 *   * `--list` takes an application and nothing else, so a run that names a
 *     subject as well is one whose author expected a write.
 *   * `--scopes` ABSENT and `--scopes=` are different invocations. Absent leaves
 *     an existing binding's scopes untouched; empty sets them to none. Folding
 *     the two together would make the next routine re-run of a deploy's bind
 *     step — which carries no `--scopes`, because it predates the column —
 *     revoke the authority somebody granted that morning.
 */
export function parseBindWorkloadIdentityArgv(argv: readonly string[]): BindWorkloadIdentityInvocation {
  const values = new Map<string, string>();
  let list = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    if (flag === '--list') {
      if (separator !== -1) throw new WorkloadBindingUsageError('--list takes no value.');
      list = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      throw new WorkloadBindingUsageError(
        `Unrecognised argument "${argument}". Known flags: --list, ${VALUE_FLAGS.join(', ')}.`,
      );
    }
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith('--')) {
      throw new WorkloadBindingUsageError(`${flag} needs a value.`);
    }
    if (values.has(flag)) throw new WorkloadBindingUsageError(`${flag} was given twice.`);
    values.set(flag, value);
  }

  const applicationId = values.get('--app-id');
  if (!applicationId) throw new WorkloadBindingUsageError('--app-id is required.');

  const roleArn = values.get('--role-arn');
  const subjectFlag = values.get('--subject');
  if (roleArn !== undefined && subjectFlag !== undefined && roleArn !== subjectFlag) {
    throw new WorkloadBindingUsageError('--role-arn and --subject name the same thing; give one.');
  }
  const subject = roleArn ?? subjectFlag;

  if (list) {
    if (
      subject !== undefined ||
      values.has('--description') ||
      values.has('--scopes') ||
      values.has('--expires-at')
    ) {
      throw new WorkloadBindingUsageError('--list reads one application\'s bindings; it writes nothing.');
    }
    return { mode: 'list', applicationId };
  }

  if (subject === undefined) {
    throw new WorkloadBindingUsageError('--role-arn (or --subject) is required unless --list is given.');
  }

  const description = values.get('--description');
  const rawScopes = values.get('--scopes');
  const expiresAt = values.get('--expires-at');
  return {
    mode: 'bind',
    request: {
      applicationId,
      subject,
      ...(values.has('--provider') ? { provider: values.get('--provider') as string } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(rawScopes !== undefined ? { scopes: parseScopeList(rawScopes) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}
