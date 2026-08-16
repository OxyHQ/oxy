/**
 * The internal cost centres Oxy books its own first-party inference spend to —
 * issue #972 workstream 14 — and the pure reconciliation decision behind
 * `scripts/seed-internal-cost-centers.ts`.
 *
 * ## A cost centre is an ACCOUNT, so seeding one creates an account
 *
 * `db/schema/internalCostCenters.ts` is explicit that there is exactly one
 * account/organization/project hierarchy and a cost centre is a LABEL on an
 * account in it, never a parallel tree. `entitlement.service.ts` attributes
 * spend by walking `applications.owner_account_id` up `user_ancestors` to the
 * nearest labelled account. Both consequences follow from that and neither is
 * optional:
 *
 *  1. Seeding a cost centre means minting a real `project` account under the
 *     platform owner. There is no lighter-weight row to create instead.
 *  2. Two workloads can only be told apart in the report if their applications
 *     have DIFFERENT owner accounts. One application owned by the platform owner
 *     contributes to whatever centre sits above the platform owner — which is
 *     why no centre is registered there, and why the Alia application is owned
 *     by `alia-production-chat` rather than by `oxy`
 *     (`seedOxyApplicationsSpecs.ts`).
 *
 * ## The slug IS the username
 *
 * A cost centre is addressed by slug in every report; the account is addressed
 * by username everywhere else. Deriving one from the other by hand is how they
 * drift, so this seed uses one string for both — which also makes the seed
 * idempotent on a name a human typed rather than on an id a machine minted.
 *
 * Pure and dependency-free (no database, no env access), so the decision is unit
 * testable without a database — the same shape as `registerCommonsClientsPlan.ts`
 * and `seedOxyApplicationsPlan.ts`.
 */

/** Rendered in a diff when the record does not exist yet. */
export const ABSENT = '(absent)';

/**
 * Rendered as the destination of an account change when the account itself is
 * minted by this run. A dry run cannot know the id the real run will allocate,
 * and inventing one would be a second lie on top of the first — the CHANGE is
 * still reported, only the value is unknowable in advance.
 */
export const PENDING_ACCOUNT = '(project account minted by this run)';

export interface InternalCostCenterSpec {
  /**
   * The cost-centre slug, and the project account's username.
   *
   * Named `name` because it is the idempotency key this run is bounded on
   * (`selectSeedEntries`), exactly as an application's `name` is.
   */
  name: string;
  /** Human-readable title, shown in reports and pickers. */
  label: string;
  /** The account's display name. */
  displayName: string;
  /** The account's description — what this workload actually is. */
  description: string;
}

/**
 * The five workloads #972 workstream 14 names, and nothing else.
 *
 * Flat under the platform owner rather than nested beneath an intermediate
 * "Alia" organization. An intermediate level would only earn its keep by being a
 * cost centre itself, and a centre that is an ancestor of the other four
 * silently absorbs the spend of any application owned directly by it — the
 * nearest-ancestor walk cannot distinguish "owned by the parent" from "owned by
 * a child with no centre of its own". Five siblings have no such ambiguity: an
 * application either has one of these owners or it has none, and "none" is the
 * correct answer for every Oxy application that is not one of these workloads.
 *
 * `Codea`, `research`, `voice` and `evaluations` are registered here ahead of
 * the applications that will book to them. That ordering is deliberate and is
 * the same one CrowdSource's redirect origin took: a centre that only exists
 * after a second round trip blocks the workload rather than the reverse. Until
 * an application is owned by one of those four accounts, their spend is
 * legitimately zero — which is a real reading of the report, not a gap in it.
 */
export const INTERNAL_COST_CENTERS: InternalCostCenterSpec[] = [
  {
    name: 'alia-production-chat',
    label: 'Alia production chat',
    displayName: 'Alia Production Chat',
    description:
      'Alia’s customer-facing chat, console, canvas and gateway surfaces — the spend of the ' +
      'registered Alia application.',
  },
  {
    name: 'codea',
    label: 'Codea',
    displayName: 'Codea',
    description: 'Codea — Alia’s coding workload.',
  },
  {
    name: 'alia-research',
    label: 'Alia research',
    displayName: 'Alia Research',
    description: 'Exploratory and research inference spend, kept off the production line.',
  },
  {
    name: 'alia-voice',
    label: 'Alia voice',
    displayName: 'Alia Voice',
    description: 'Speech-to-text, text-to-speech and realtime voice workloads.',
  },
  {
    name: 'alia-evaluations',
    label: 'Alia evaluations',
    displayName: 'Alia Evaluations',
    description:
      'Model evaluation and benchmarking runs — spend that must never be read as customer ' +
      'traffic.',
  },
];

/** What the database currently holds for one spec. */
export interface CostCenterObservation {
  /** The cost-centre row already registered under this slug, if any. */
  costCenter: {
    accountId: string;
    label: string;
    status: 'active' | 'retired';
  } | null;
  /** The account currently holding this slug as its username, if any. */
  usernameHolder: {
    id: string;
    kind: string;
    parentAccountId: string | null;
    accountStatus: string;
  } | null;
}

export interface PlannedCostCenterChange {
  field: 'account' | 'label' | 'status';
  from: string;
  to: string;
}

/**
 * How this run would obtain the account the centre labels.
 *
 *  - `registered` — a cost-centre row already names an account. Nothing is
 *    minted; only the label/status are reconciled.
 *  - `adopt` — no cost-centre row, but a project account under the platform
 *    owner already holds this username. Label it.
 *  - `create` — mint the project account, then label it.
 *  - `refuse` — the username is held by something this seed must not touch.
 */
export type CostCenterAccountAction =
  | { kind: 'registered'; accountId: string }
  | { kind: 'adopt'; accountId: string }
  | { kind: 'create' }
  | { kind: 'refuse'; reason: string };

export interface CostCenterPlan {
  action: CostCenterAccountAction;
  /** Empty ⇔ this run would write nothing for this centre. */
  changes: PlannedCostCenterChange[];
}

/**
 * Compute the FULL plan for one cost centre.
 *
 * Called unconditionally on both the dry-run and the real path, so the two
 * cannot disagree — `DRY_RUN` gates only whether the writes happen, never what
 * is computed or reported. The bug this shape exists to prevent is a dry run
 * that under-reports a write it is about to make: the next operator trusts it.
 *
 * REFUSES rather than working around a username collision. `AccountService`
 * would happily allocate `codea1` for a taken `codea`, and that is the wrong
 * behaviour here even though nothing would break: the slug would still be
 * unique, the report would still balance, and the account a human later looks
 * up by handle would be somebody else's. A refusal costs one rename by an
 * operator who can see both accounts; a silent suffix costs the next person a
 * day.
 *
 * @param spec The registered centre.
 * @param observation What the database holds for it today.
 * @param platformOwnerId The account every seeded centre must be a child of.
 */
export function computeCostCenterPlan(
  spec: InternalCostCenterSpec,
  observation: CostCenterObservation,
  platformOwnerId: string
): CostCenterPlan {
  const { costCenter, usernameHolder } = observation;

  if (costCenter !== null) {
    const changes: PlannedCostCenterChange[] = [];
    if (costCenter.label !== spec.label) {
      changes.push({ field: 'label', from: costCenter.label, to: spec.label });
    }
    // `registerCostCenter` sets `status` back to `active` on conflict, so
    // re-running over a RETIRED centre revives it. That is a real change and has
    // to be reported as one — an operator who retired a centre on purpose needs
    // to see the run is about to undo it, before it does.
    if (costCenter.status !== 'active') {
      changes.push({ field: 'status', from: costCenter.status, to: 'active' });
    }
    return { action: { kind: 'registered', accountId: costCenter.accountId }, changes };
  }

  const labelling: PlannedCostCenterChange[] = [
    { field: 'label', from: ABSENT, to: spec.label },
    { field: 'status', from: ABSENT, to: 'active' },
  ];

  if (usernameHolder === null) {
    return {
      action: { kind: 'create' },
      changes: [{ field: 'account', from: ABSENT, to: PENDING_ACCOUNT }, ...labelling],
    };
  }

  if (usernameHolder.kind !== 'project') {
    return {
      action: {
        kind: 'refuse',
        reason:
          `the username "${spec.name}" is held by a "${usernameHolder.kind}" account, not a ` +
          'project. Rename the cost centre, or rename that account — this seed will not ' +
          'label an account it did not create.',
      },
      changes: [],
    };
  }
  if (usernameHolder.parentAccountId !== platformOwnerId) {
    return {
      action: {
        kind: 'refuse',
        reason:
          `the username "${spec.name}" is held by a project account outside the platform ` +
          'owner’s subtree. Labelling it would book Oxy’s own spend to somebody else’s tree.',
      },
      changes: [],
    };
  }
  if (usernameHolder.accountStatus !== 'active') {
    return {
      action: {
        kind: 'refuse',
        reason:
          `the username "${spec.name}" is held by an "${usernameHolder.accountStatus}" project ` +
          'account. Reactivate it deliberately, or pick another slug — spend booked to an ' +
          'archived account is spend nobody is watching.',
      },
      changes: [],
    };
  }

  return {
    action: { kind: 'adopt', accountId: usernameHolder.id },
    changes: [
      { field: 'account', from: ABSENT, to: usernameHolder.id },
      ...labelling,
    ],
  };
}
