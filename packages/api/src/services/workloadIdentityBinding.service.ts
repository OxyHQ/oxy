import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { isTrustedApplication } from '../utils/trustedApplication';
import {
  canonicalAwsSubject,
  isAttestationProvider,
  type AttestationProvider,
} from './workloadAttestation.service';

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
  | 'subject_bound_elsewhere';

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
  expiresAt: Date | null;
  createdAt: Date;
}

export interface WorkloadBindingRequest {
  applicationId: string;
  /** Defaults to the only provider with a verifier today. */
  provider?: string;
  /** A role ARN, or the assumed-role ARN a task reports — both canonicalise. */
  subject: string;
  description?: string;
  /** ISO 8601. Absent means the binding does not wind itself down. */
  expiresAt?: string;
}

export interface WorkloadBindingResult {
  /** `created` wrote a row; `unchanged` found the identical binding already there. */
  state: 'created' | 'unchanged';
  binding: WorkloadBindingRow;
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

const BINDING_COLUMNS = {
  id: applicationWorkloadIdentities.id,
  applicationId: applicationWorkloadIdentities.applicationId,
  provider: applicationWorkloadIdentities.provider,
  subject: applicationWorkloadIdentities.subject,
  description: applicationWorkloadIdentities.description,
  expiresAt: applicationWorkloadIdentities.expiresAt,
  createdAt: applicationWorkloadIdentities.createdAt,
} as const;

/**
 * The shape `canonicalAwsSubject` produces from a real attestation, and the only
 * shape a binding may store.
 *
 * Deliberately as permissive about the partition and the account as the verifier
 * is: this asserts the RESULT, it does not re-decide it, and a pattern stricter
 * than the one upstream would refuse a subject the verifier can genuinely
 * present — which is the same dead binding by the opposite route.
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
  return row;
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
 */
function reconcileExisting(
  existing: WorkloadBindingRow,
  request: { applicationId: string; description?: string; expiresAt: Date | null },
): WorkloadBindingResult {
  if (existing.applicationId !== request.applicationId) {
    throw new WorkloadBindingError(
      'subject_bound_elsewhere',
      `${existing.provider} subject ${existing.subject} is already bound to application ` +
        `${existing.applicationId}; refusing to repoint it at ${request.applicationId}. ` +
        'Repointing would hand one service another service\'s identity without either noticing. ' +
        'Delete the existing binding first if the move is intended.',
    );
  }
  const ignoredChanges = describeDrift(existing, request.description, request.expiresAt);
  return {
    state: 'unchanged',
    binding: existing,
    ...(ignoredChanges.length > 0 ? { ignoredChanges } : {}),
  };
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
    description: request.description,
    expiresAt,
  };

  const existing = await findBinding(provider, subject);
  if (existing) return reconcileExisting(existing, reconcileAgainst);

  try {
    const [created] = await getDb()
      .insert(applicationWorkloadIdentities)
      .values({
        applicationId: application.id,
        provider,
        subject,
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(expiresAt !== null ? { expiresAt } : {}),
      })
      .returning(BINDING_COLUMNS);
    return { state: 'created', binding: created };
  } catch (error: unknown) {
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
  return getDb()
    .select(BINDING_COLUMNS)
    .from(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.applicationId, applicationId))
    .orderBy(asc(applicationWorkloadIdentities.provider), asc(applicationWorkloadIdentities.subject));
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

const VALUE_FLAGS = ['--app-id', '--role-arn', '--subject', '--provider', '--description', '--expires-at'] as const;

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
    if (subject !== undefined || values.has('--description') || values.has('--expires-at')) {
      throw new WorkloadBindingUsageError('--list reads one application\'s bindings; it writes nothing.');
    }
    return { mode: 'list', applicationId };
  }

  if (subject === undefined) {
    throw new WorkloadBindingUsageError('--role-arn (or --subject) is required unless --list is given.');
  }

  const description = values.get('--description');
  const expiresAt = values.get('--expires-at');
  return {
    mode: 'bind',
    request: {
      applicationId,
      subject,
      ...(values.has('--provider') ? { provider: values.get('--provider') as string } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}
