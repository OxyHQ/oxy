/**
 * The catalogue's commercial-permission workflow (issue #972, workstream 11).
 *
 * A technically callable provider route is not automatically publicly
 * resellable. This is the surface that moves a route between permission states,
 * and it is deliberately small: four verbs, each writing one state plus who did
 * it and when.
 *
 * ## Staff-gated, consistently with how this repo already gates staff-only fields
 *
 * `Application.type` / `isOfficial` / `isInternal` / `capabilities` are gated by
 * `requireStaff` (`middleware/requireStaff.ts`), and so is this — a route's
 * commercial permission is the same class of decision: it cannot be granted
 * through any customer-held role, because the thing being asserted is that OXY
 * has the right to resell somebody else's model, which no customer can know.
 *
 * ## What is NOT here, and where it goes instead
 *
 * **Publishing a price version.** `price_versions` is the LEDGER's table
 * (workstream 7). This is the natural home for its authoring verb — the model
 * revision and provider a price is scoped to already live here — but that table
 * is not in this schema barrel yet, so writing it now would be code that cannot
 * compile. It is an INTENDED addition to this module, not an existing one, and
 * the append-only rule is not negotiable when it lands: a price change is a new
 * row, and an existing row is never edited.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  type DeploymentLegalReviewStatus,
  type DeploymentPermissionState,
  inferenceDeployments,
} from '../db/schema';

/** The four transitions this workflow offers, as the route layer names them. */
export const DEPLOYMENT_PERMISSION_ACTIONS = [
  'approve',
  'restrict',
  'suspend',
  'retire',
] as const;

export type DeploymentPermissionAction = (typeof DEPLOYMENT_PERMISSION_ACTIONS)[number];

/**
 * The state each action writes.
 *
 * A map rather than a switch so the pairing is DATA, and a test can assert that
 * every action lands on a real permission state and that no action lands on
 * `pending_review` — an action that walked a route BACK to the default would be
 * indistinguishable from never having reviewed it.
 */
export const ACTION_TARGET_STATE: Readonly<
  Record<DeploymentPermissionAction, DeploymentPermissionState>
> = {
  approve: 'approved',
  restrict: 'restricted',
  suspend: 'suspended',
  retire: 'retired',
};

/**
 * A route whose permission state has moved, as reported back to staff.
 *
 * Carries no wholesale cost and no internal route id: this is a staff surface,
 * but the response of a state change has no reason to repeat commercially
 * sensitive fields, and not returning them means one fewer place they can be
 * logged or forwarded.
 */
export interface DeploymentPermissionResult {
  readonly deploymentId: string;
  readonly permissionState: DeploymentPermissionState;
  readonly legalReviewStatus: DeploymentLegalReviewStatus;
  readonly changedAt: Date;
}

/** Raised when the requested route does not exist. */
export class DeploymentNotFoundError extends Error {
  constructor(deploymentId: string) {
    super(`No inference deployment with id ${deploymentId}`);
    this.name = 'DeploymentNotFoundError';
  }
}

/**
 * Raised when the transition is refused for a reason the database would state
 * as a constraint violation.
 *
 * Distinguished from a constraint error so the route layer can answer 409 with
 * a sentence rather than surfacing a SQLSTATE — but the CONSTRAINT is still
 * there and still authoritative: this class is a better message, never the
 * enforcement.
 */
export class DeploymentPermissionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentPermissionRefused';
  }
}

export interface RecordLegalReviewInput {
  readonly deploymentId: string;
  readonly status: DeploymentLegalReviewStatus;
  /**
   * A pointer into whatever register holds the contract — a matter reference,
   * an envelope id. Never the contract itself: the catalogue deliberately
   * stores no confidential agreement.
   */
  readonly evidenceRef?: string;
  readonly reviewerUserId: string;
}

/**
 * Record the outcome of a contract/legal review.
 *
 * Separate from {@link applyPermissionAction} on purpose. Reviewing and
 * approving are two decisions, usually by two people, and folding them into one
 * call would make "approved" mean "somebody clicked approve" — the database
 * refuses an approval whose review is not itself approved, and this is the only
 * way to satisfy it.
 */
export async function recordLegalReview(
  input: RecordLegalReviewInput
): Promise<DeploymentPermissionResult> {
  const evidenceRef = input.evidenceRef?.trim();

  if (input.status === 'approved' && (evidenceRef === undefined || evidenceRef.length === 0)) {
    throw new DeploymentPermissionRefused(
      'A legal approval must cite its evidence reference. The catalogue stores a pointer into the contract register, never the contract.'
    );
  }

  const reviewedAt = new Date();
  const [row] = await getDb()
    .update(inferenceDeployments)
    .set({
      legalReviewStatus: input.status,
      legalReviewEvidenceRef: evidenceRef ?? null,
      legalReviewedAt: reviewedAt,
      legalReviewedByUserId: input.reviewerUserId,
    })
    .where(eq(inferenceDeployments.id, input.deploymentId))
    .returning({
      deploymentId: inferenceDeployments.id,
      permissionState: inferenceDeployments.permissionState,
      legalReviewStatus: inferenceDeployments.legalReviewStatus,
    });

  if (row === undefined) throw new DeploymentNotFoundError(input.deploymentId);

  return {
    deploymentId: row.deploymentId,
    permissionState: row.permissionState,
    legalReviewStatus: row.legalReviewStatus,
    changedAt: reviewedAt,
  };
}

export interface PermissionActionInput {
  readonly deploymentId: string;
  readonly action: DeploymentPermissionAction;
  readonly staffUserId: string;
  /** Why, in one line. Staff-visible only; never part of the customer view. */
  readonly note?: string;
}

/**
 * Approve, restrict, suspend or retire a route.
 *
 * `approve` is refused by the DATABASE unless the legal review is itself
 * approved (`inference_deployments_approval_requires_legal_review`), so this
 * function checks the same thing first only to produce a readable message. The
 * check here is a courtesy; the constraint is the control, and removing this
 * function would not make an unreviewed route approvable.
 *
 * A retired route stays retired: moving out of `retired` is not offered, because
 * a route that was withdrawn and quietly restored is exactly the state a
 * customer cannot verify and a contract review cannot audit. Re-offering means
 * a new row.
 */
export async function applyPermissionAction(
  input: PermissionActionInput
): Promise<DeploymentPermissionResult> {
  const db = getDb();

  const [existing] = await db
    .select({
      id: inferenceDeployments.id,
      permissionState: inferenceDeployments.permissionState,
      legalReviewStatus: inferenceDeployments.legalReviewStatus,
    })
    .from(inferenceDeployments)
    .where(eq(inferenceDeployments.id, input.deploymentId));

  if (existing === undefined) throw new DeploymentNotFoundError(input.deploymentId);

  if (existing.permissionState === 'retired') {
    throw new DeploymentPermissionRefused(
      'A retired route stays retired. Re-offering the same model on the same provider is a new deployment, so the decision is visible and reviewable.'
    );
  }

  if (input.action === 'approve' && existing.legalReviewStatus !== 'approved') {
    throw new DeploymentPermissionRefused(
      'This route cannot be approved until its contract/legal review is approved and its evidence reference recorded.'
    );
  }

  const changedAt = new Date();
  const [row] = await db
    .update(inferenceDeployments)
    .set({
      permissionState: ACTION_TARGET_STATE[input.action],
      permissionStateChangedAt: changedAt,
      permissionStateChangedByUserId: input.staffUserId,
      permissionStateNote: input.note?.trim() ?? null,
    })
    // Re-asserted in the WHERE so a concurrent retire cannot be overwritten by
    // an approve that read the row a moment earlier. The read above is for the
    // message; this is the atomicity.
    .where(
      and(
        eq(inferenceDeployments.id, input.deploymentId),
        eq(inferenceDeployments.permissionState, existing.permissionState)
      )
    )
    .returning({
      deploymentId: inferenceDeployments.id,
      permissionState: inferenceDeployments.permissionState,
      legalReviewStatus: inferenceDeployments.legalReviewStatus,
    });

  if (row === undefined) {
    throw new DeploymentPermissionRefused(
      'The route changed state while this request was in flight. Re-read it and decide again.'
    );
  }

  return {
    deploymentId: row.deploymentId,
    permissionState: row.permissionState,
    legalReviewStatus: row.legalReviewStatus,
    changedAt,
  };
}
