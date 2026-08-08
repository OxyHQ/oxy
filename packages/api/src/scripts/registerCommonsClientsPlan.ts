/**
 * The reconciliation DECISION behind `scripts/register-commons-clients.ts`,
 * extracted as pure functions so the dry run and the real run cannot disagree.
 *
 * WHY THIS MODULE EXISTS. The script's `DRY_RUN=1` mode exists to answer "what
 * would you change?" — an answer an operator acts on. It used to compute the
 * answer on a different code path from the one that performs the write (the
 * whole reconcile block was inside an `if (!dryRun)`), so the dry run reported
 * `appsUpdated: 0` and then the real run immediately after granted the
 * `identity:approval` capability and reported `appsUpdated: 2`. A dry run that
 * under-reports a write it is about to make is worse than no dry run at all: the
 * next operator trusts it.
 *
 * The fix is structural, not a second copy of the rules kept in sync by hand:
 *
 *   - {@link computeApplicationPlan} decides EVERYTHING — which fields change,
 *     what they change from, and what they change to — and it is called
 *     unconditionally, on both paths.
 *   - {@link applyApplicationPlan} performs the write from that same plan, field
 *     for field. It is the ONLY writer, so "what was reported" and "what was
 *     written" are the same list by construction.
 *   - `DRY_RUN` gates exactly one thing: whether `applyApplicationPlan` (and the
 *     `save()`) is called at all. It never changes what is computed or reported.
 *
 * Non-destructive by construction: array fields are UNIONed with what the record
 * already has (an existing redirect URI / scope / capability is never stripped),
 * and the scalar reconciliations only ever move a record TOWARD the registered
 * official state.
 *
 * Mongoose-free and DB-free — the only imports are types — so the whole decision
 * is unit-testable without a database.
 */

import type { ApplicationStatus, ApplicationType } from '../db/schema/applications';
import type { ApplicationCapability } from '../utils/applicationCapabilities';
import type { ApplicationScope } from '../utils/applicationScopes';

/** Rendered in a diff when the record itself does not exist yet. */
const ABSENT = '(absent)';
/** Rendered in a diff for an empty list / an unset owner. */
const NONE = '(none)';
/**
 * Rendered as the destination of an `ownerAccountId` change when the owning
 * account does not exist yet: a dry run cannot know the id the real run will
 * mint, and inventing one would be another lie. The CHANGE is still reported —
 * only the value is unknowable in advance.
 */
export const PENDING_OWNER_ACCOUNT = '(organization account minted by this run)';

/**
 * The fields of an `Application` this registration reconciles. Everything else
 * on the document (name, description, timestamps, …) is out of scope: the script
 * writes those only when it CREATES the record.
 */
export interface ApplicationRegistrationState {
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  /** Stringified id, or `null` when the record carries no owning account. */
  ownerAccountId: string | null;
  redirectUris: string[];
  scopes: ApplicationScope[];
  capabilities: string[];
}

/** The registered state the script is reconciling a record TOWARD. */
export interface ApplicationRegistrationTarget {
  type: ApplicationType;
  /** UNIONed into the record's existing list — never replaces it. */
  redirectUris: readonly string[];
  /** UNIONed into the record's existing list — never replaces it. */
  scopes: readonly ApplicationScope[];
  /** UNIONed into the record's existing list — never replaces it. */
  capabilities: readonly ApplicationCapability[];
  /**
   * Stringified id of the owning account, or `null` when that account does not
   * exist yet and this run would mint it (only reachable in a dry run — a real
   * run creates it before reconciling).
   */
  ownerAccountId: string | null;
}

export type ApplicationRegistrationField = keyof ApplicationRegistrationState;

/**
 * One field-level entry of the plan — what an operator reads to see WHICH field
 * would change, not just how many did.
 */
export interface PlannedFieldChange {
  field: ApplicationRegistrationField;
  /** Human-readable current value ({@link ABSENT} when the record is new). */
  from: string;
  /** Human-readable value after this run. */
  to: string;
}

export interface ApplicationRegistrationPlan {
  /** `true` when the record does not exist yet and this run would create it. */
  creates: boolean;
  /**
   * Empty ⇔ this run would write nothing. The dry run reports exactly this list,
   * and {@link applyApplicationPlan} writes exactly the fields in it — there is
   * no second, parallel notion of "what changed".
   */
  changes: PlannedFieldChange[];
  /**
   * The complete state the record will be in after this run. The writer reads
   * its values from here; `ownerAccountId` is stringified for reporting (`null`
   * when the owning account is minted by this run), so the writer takes the
   * resolved id from its caller instead — its runtime type differs between a
   * Mongoose document (`ObjectId`) and this plan (`string`).
   */
  desired: ApplicationRegistrationState;
}

/**
 * The fields {@link applyApplicationPlan} writes. A Mongoose `IApplication`
 * document satisfies this structurally; so does a plain object in a test —
 * which is what lets the tests exercise the REAL writer.
 *
 * Generic in the owner-id type for exactly that reason: `ObjectId` in
 * production, `string` in a test.
 */
export interface MutableApplicationFields<TOwnerId> {
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  ownerAccountId: TOwnerId;
  redirectUris: string[];
  scopes: ApplicationScope[];
  capabilities: string[];
}

/**
 * The shape {@link readApplicationState} accepts — the Mongoose document, read
 * defensively: a legacy record may carry a missing/null array.
 */
export interface ReadableApplication {
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  ownerAccountId?: { toString(): string } | null;
  redirectUris?: string[] | null;
  scopes?: ApplicationScope[] | null;
  capabilities?: string[] | null;
}

/** Union preserving the existing order, then the additions, de-duplicated. */
function union<T extends string>(current: readonly T[], additions: readonly T[]): T[] {
  return Array.from(new Set<T>([...current, ...additions]));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : NONE;
}

/** Project a persisted application onto the fields this registration owns. */
export function readApplicationState(application: ReadableApplication): ApplicationRegistrationState {
  return {
    status: application.status,
    type: application.type,
    isOfficial: application.isOfficial,
    isInternal: application.isInternal,
    ownerAccountId: application.ownerAccountId?.toString() ?? null,
    redirectUris: [...(application.redirectUris ?? [])],
    scopes: [...(application.scopes ?? [])],
    capabilities: [...(application.capabilities ?? [])],
  };
}

/**
 * Compute the FULL plan for one client.
 *
 * @param current - The record's present state, or `null` when it does not exist.
 * @param target  - The registered state to reconcile toward.
 */
export function computeApplicationPlan(
  current: ApplicationRegistrationState | null,
  target: ApplicationRegistrationTarget
): ApplicationRegistrationPlan {
  const desired: ApplicationRegistrationState = {
    status: 'active',
    type: target.type,
    isOfficial: true,
    isInternal: target.type === 'internal',
    ownerAccountId: target.ownerAccountId,
    redirectUris: union(current?.redirectUris ?? [], target.redirectUris),
    scopes: union(current?.scopes ?? [], target.scopes),
    capabilities: union(current?.capabilities ?? [], target.capabilities),
  };

  if (!current) {
    return {
      creates: true,
      changes: [
        { field: 'status', from: ABSENT, to: desired.status },
        { field: 'type', from: ABSENT, to: desired.type },
        { field: 'isOfficial', from: ABSENT, to: String(desired.isOfficial) },
        { field: 'isInternal', from: ABSENT, to: String(desired.isInternal) },
        {
          field: 'ownerAccountId',
          from: ABSENT,
          to: desired.ownerAccountId ?? PENDING_OWNER_ACCOUNT,
        },
        { field: 'redirectUris', from: ABSENT, to: formatList(desired.redirectUris) },
        { field: 'scopes', from: ABSENT, to: formatList(desired.scopes) },
        { field: 'capabilities', from: ABSENT, to: formatList(desired.capabilities) },
      ],
      desired,
    };
  }

  const changes: PlannedFieldChange[] = [];

  if (current.status !== desired.status) {
    changes.push({ field: 'status', from: current.status, to: desired.status });
  }
  if (current.type !== desired.type) {
    changes.push({ field: 'type', from: current.type, to: desired.type });
  }
  if (current.isOfficial !== desired.isOfficial) {
    changes.push({
      field: 'isOfficial',
      from: String(current.isOfficial),
      to: String(desired.isOfficial),
    });
  }
  if (current.isInternal !== desired.isInternal) {
    changes.push({
      field: 'isInternal',
      from: String(current.isInternal),
      to: String(desired.isInternal),
    });
  }
  // A target owner of `null` means the owning account itself is minted by this
  // run, so no existing record can already point at it — always a change.
  if (desired.ownerAccountId === null || current.ownerAccountId !== desired.ownerAccountId) {
    changes.push({
      field: 'ownerAccountId',
      from: current.ownerAccountId ?? NONE,
      to: desired.ownerAccountId ?? PENDING_OWNER_ACCOUNT,
    });
  }
  if (!sameSequence(current.redirectUris, desired.redirectUris)) {
    changes.push({
      field: 'redirectUris',
      from: formatList(current.redirectUris),
      to: formatList(desired.redirectUris),
    });
  }
  if (!sameSequence(current.scopes, desired.scopes)) {
    changes.push({
      field: 'scopes',
      from: formatList(current.scopes),
      to: formatList(desired.scopes),
    });
  }
  if (!sameSequence(current.capabilities, desired.capabilities)) {
    changes.push({
      field: 'capabilities',
      from: formatList(current.capabilities),
      to: formatList(desired.capabilities),
    });
  }

  return { creates: false, changes, desired };
}

/**
 * Write a plan onto a record. THE ONLY WRITER — the real run calls this with the
 * Mongoose document, the tests call it with a plain object, and neither can
 * write a field the plan did not report.
 *
 * @param target - The record to mutate.
 * @param plan - The plan from {@link computeApplicationPlan}.
 * @param ownerAccountId - The RESOLVED owning-account id, in the target's own id
 *   type. Used only when the plan changes `ownerAccountId`.
 * @returns The fields written, in plan order — always equal to
 *   `plan.changes.map(c => c.field)`.
 */
export function applyApplicationPlan<TOwnerId>(
  target: MutableApplicationFields<TOwnerId>,
  plan: ApplicationRegistrationPlan,
  ownerAccountId: TOwnerId
): ApplicationRegistrationField[] {
  const written: ApplicationRegistrationField[] = [];

  for (const { field } of plan.changes) {
    switch (field) {
      case 'status':
        target.status = plan.desired.status;
        break;
      case 'type':
        target.type = plan.desired.type;
        break;
      case 'isOfficial':
        target.isOfficial = plan.desired.isOfficial;
        break;
      case 'isInternal':
        target.isInternal = plan.desired.isInternal;
        break;
      case 'ownerAccountId':
        target.ownerAccountId = ownerAccountId;
        break;
      case 'redirectUris':
        target.redirectUris = [...plan.desired.redirectUris];
        break;
      case 'scopes':
        target.scopes = [...plan.desired.scopes];
        break;
      case 'capabilities':
        target.capabilities = [...plan.desired.capabilities];
        break;
      default: {
        // Compile-time exhaustiveness: a new reconciled field cannot be added to
        // `ApplicationRegistrationState` (and therefore reported by a plan)
        // without also being written here.
        const unhandled: never = field;
        throw new Error(`Unhandled application field in plan: ${String(unhandled)}`);
      }
    }
    written.push(field);
  }

  return written;
}
