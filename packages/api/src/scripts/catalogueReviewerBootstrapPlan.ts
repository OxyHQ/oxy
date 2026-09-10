import { STAFF_CAPABILITIES, type StaffCapability } from '../db/schema/users';

export const CATALOGUE_PUBLISH_CAPABILITY =
  'inference:catalogue:publish' as const satisfies StaffCapability;

export interface CatalogueReviewerState {
  readonly userId: string;
  readonly isStaff: boolean;
  readonly staffCapabilities: readonly string[];
}

export interface CatalogueReviewerBootstrapPlan {
  readonly userId: string;
  readonly capability: typeof CATALOGUE_PUBLISH_CAPABILITY;
  readonly changed: boolean;
  readonly previousIsStaff: boolean;
  readonly nextIsStaff: true;
  readonly previousCapabilities: readonly StaffCapability[];
  readonly nextCapabilities: readonly StaffCapability[];
}

/**
 * Build the one permitted staff-bootstrap transition. The target remains an
 * opaque exact id: this function never trims, normalizes or resolves a name.
 */
export function planCatalogueReviewerBootstrap(
  current: CatalogueReviewerState,
): CatalogueReviewerBootstrapPlan {
  if (
    current.userId.length === 0 ||
    current.userId.length > 128 ||
    current.userId.trim() !== current.userId
  ) {
    throw new Error('STAFF_BOOTSTRAP_USER_ID must be a non-empty exact opaque user id');
  }

  const allowed = new Set<string>(STAFF_CAPABILITIES);
  if (!current.staffCapabilities.every((capability) => allowed.has(capability))) {
    throw new Error('Stored staff capabilities contain an unknown value');
  }
  const currentCapabilities = [...current.staffCapabilities] as StaffCapability[];

  const hasCapability = currentCapabilities.includes(CATALOGUE_PUBLISH_CAPABILITY);
  return {
    userId: current.userId,
    capability: CATALOGUE_PUBLISH_CAPABILITY,
    changed: current.isStaff !== true || !hasCapability,
    previousIsStaff: current.isStaff,
    nextIsStaff: true,
    previousCapabilities: currentCapabilities,
    nextCapabilities: hasCapability
      ? [...currentCapabilities]
      : [...currentCapabilities, CATALOGUE_PUBLISH_CAPABILITY],
  };
}
